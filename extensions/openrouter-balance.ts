/**
 * pi-openrouter-balance
 *
 * OpenRouter account balance and key usage in the pi footer, with a
 * /openrouter-balance report. Single extension file; zero runtime
 * dependencies; all system boundaries (fetch, clock, timers, auth, fs,
 * host UI) are injectable — see tests/helpers.ts.
 *
 * Layers (in file order): constants & types → pure helpers → auth →
 * usage client → metrics & formatters → overlay → lifecycle → command.
 * Terms follow CONTEXT.md; decisions live in docs/adr/.
 */
import { createHash, createHmac } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & domain types
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_ID = "openrouter";
export const STATUS_KEY = "pi-openrouter-balance";
export const KEY_URL = "https://openrouter.ai/api/v1/key";
export const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const USAGE_PAGE_URL = "https://openrouter.ai/settings/usage";
export const SNAPSHOT_SALT_PREFIX = "pi-openrouter-balance\0";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;
const RETRY_AFTER_CAP_MS = 15 * 60_000;
const MAX_DISPLAY_CHARS = 160;

export type LimitResetCadence = "daily" | "weekly" | "monthly" | string;

export interface KeyStatus {
	label?: string;
	isManagementKey?: boolean;
	isProvisioningKey?: boolean;
	limit?: number | null;
	limitReset?: LimitResetCadence;
	limitRemaining?: number | null;
	includeByokInLimit?: boolean;
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
	byokUsage?: number;
	byokUsageDaily?: number;
	byokUsageWeekly?: number;
	byokUsageMonthly?: number;
	freeTier: boolean;
	expiresAt?: string | null;
	userId?: string;
}

export interface AccountBalance {
	totalCredits: number;
	totalUsage: number;
	balance: number; // totalCredits − totalUsage; may be negative
}

export interface BurnRate {
	perHour: number;
	windowHours: number;
}

export interface Snapshot {
	schemaVersion: 1;
	capturedAt: number;
	fingerprint: string;
	key: KeyStatus;
	account?: AccountBalance;
	balanceUnavailable?: boolean;
	burnRate?: BurnRate;
	warnings: string[];
}

/** Classified error carried by the client; never thrown into the pi host. */
export class UsageError extends Error {
	readonly code: "auth" | "parse" | "timeout" | "transient" | "insufficient";
	constructor(code: UsageError["code"], message: string) {
		super(message);
		this.name = "UsageError";
		this.code = code;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Strip ANSI/control characters and cap length for display strings. */
export function sanitizeDisplayText(value: string, maxChars = MAX_DISPLAY_CHARS): string | undefined {
	const cleaned = value.replace(/[\u0000-\u001f\u007f\u009b]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

export function parseLimitReset(value: unknown): LimitResetCadence | undefined {
	const s = asString(value);
	if (s === undefined || s.trim() === "") return undefined;
	return s.trim().toLowerCase();
}

/** Stable non-secret identity for persistence: HMAC of creator_user_id (label fallback). */
export function fingerprintOf(userId: string | undefined, label?: string): string {
	const raw = (userId && userId.trim()) || (label && label.trim()) || "";
	return createHmac("sha256", SNAPSHOT_SALT_PREFIX).update(raw).digest("hex").slice(0, 16);
}

export function parseKeyStatus(payload: unknown): KeyStatus {
	const root = asObject(payload);
	const data = asObject(root?.data);
	if (!data) throw new UsageError("parse", "key payload was not an object");
	const usage = asNumber(data.usage);
	const usageDaily = asNumber(data.usage_daily);
	const usageWeekly = asNumber(data.usage_weekly);
	const usageMonthly = asNumber(data.usage_monthly);
	const freeTier = asBoolean(data.is_free_tier);
	if (usage === undefined || usageDaily === undefined || usageWeekly === undefined || usageMonthly === undefined || freeTier === undefined) {
		throw new UsageError("parse", "key payload missing required fields");
	}
	// Wire semantics: null means "no cap / unlimited"; keep null, convert numerics.
	const limit = data.limit === null || data.limit === undefined ? (data.limit ?? null) : asNumber(data.limit);
	const limitRemaining = data.limit_remaining === null || data.limit_remaining === undefined ? (data.limit_remaining ?? null) : asNumber(data.limit_remaining);
	const byokUsage = asNumber(data.byok_usage);
	const byokDaily = asNumber(data.byok_usage_daily);
	const byokWeekly = asNumber(data.byok_usage_weekly);
	const byokMonthly = asNumber(data.byok_usage_monthly);
	const label = sanitizeDisplayText(asString(data.label) ?? "");
	return {
		...(label ? { label } : {}),
		...(asBoolean(data.is_management_key) !== undefined ? { isManagementKey: asBoolean(data.is_management_key) } : {}),
		...(asBoolean(data.is_provisioning_key) !== undefined ? { isProvisioningKey: asBoolean(data.is_provisioning_key) } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(parseLimitReset(data.limit_reset) !== undefined ? { limitReset: parseLimitReset(data.limit_reset) } : {}),
		...(limitRemaining !== undefined ? { limitRemaining } : {}),
		...(asBoolean(data.include_byok_in_limit) !== undefined ? { includeByokInLimit: asBoolean(data.include_byok_in_limit) } : {}),
		usage,
		usageDaily,
		usageWeekly,
		usageMonthly,
		...(byokUsage !== undefined ? { byokUsage } : {}),
		...(byokDaily !== undefined ? { byokUsageDaily: byokDaily } : {}),
		...(byokWeekly !== undefined ? { byokUsageWeekly: byokWeekly } : {}),
		...(byokMonthly !== undefined ? { byokUsageMonthly: byokMonthly } : {}),
		freeTier,
		...(data.expires_at !== undefined && data.expires_at !== null ? { expiresAt: asString(data.expires_at) ?? String(data.expires_at) } : {}),
		...(asString(data.creator_user_id) ? { userId: asString(data.creator_user_id) } : {}),
	};
}

export function parseCredits(payload: unknown): AccountBalance {
	const root = asObject(payload);
	const data = asObject(root?.data);
	if (!data) throw new UsageError("parse", "credits payload was not an object");
	const totalCredits = asNumber(data.total_credits);
	const totalUsage = asNumber(data.total_usage);
	if (totalCredits === undefined || totalUsage === undefined) {
		throw new UsageError("parse", "credits payload missing required fields");
	}
	return { totalCredits, totalUsage, balance: totalCredits - totalUsage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryLike {
	getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string } | undefined>;
}

export interface CtxLike {
	modelRegistry?: RegistryLike;
	model?: { id?: string; name?: string; provider?: string } | null;
	mode?: string;
	hasUI?: boolean;
	ui?: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, level: string): void;
		theme: { fg(role: string, text: string): string };
	} & Record<string, unknown>;
}

export type AuthResolution =
	| { status: "ok"; token: string; source?: string }
	| { status: "no-auth" }
	| { status: "auth-error"; message: string };

/** Resolve the OpenRouter credential through pi (env key or OAuth; pi refreshes). */
export async function resolveOpenRouterAuth(ctx: CtxLike): Promise<AuthResolution> {
	const registry = ctx.modelRegistry;
	if (!registry) return { status: "no-auth" };
	let resolved: { auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string } | undefined;
	try {
		resolved = await registry.getProviderAuth(PROVIDER_ID);
	} catch (error) {
		return { status: "auth-error", message: error instanceof Error ? error.message : String(error) };
	}
	const token = resolved?.auth?.apiKey?.trim();
	if (!token) return { status: "no-auth" };
	return { status: "ok", token, ...(resolved?.source ? { source: resolved.source } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage client
// ─────────────────────────────────────────────────────────────────────────────

export type UsageResult =
	| { status: "ok"; snapshot: Snapshot }
	| { status: "retry"; retryAfterMs: number }
	| { status: "error"; code: UsageError["code"]; message: string };

export interface UsageClientLike {
	fetchSnapshot(token: string, signal?: AbortSignal): Promise<UsageResult>;
	resetBreaker(): void;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			if (signal?.aborted) throw new UsageError("timeout", "request aborted");
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				try { void reader.cancel(); } catch { /* */ }
				throw new UsageError("parse", "response body exceeded limit");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		try { reader.releaseLock(); } catch { /* */ }
	}
}

/** Redact bearer/key-shaped strings from an error message. */
export function redactError(message: string, secrets: readonly string[]): string {
	let out = message;
	for (const s of secrets) {
		if (s && s.length > 3) out = out.split(s).join("<redacted>");
	}
	out = out.replace(/sk-or-v[0-9a-zA-Z-]+/gi, "sk-or-v<redacted>");
	out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted-Bearer>");
	return out;
}

export function parseRetryAfter(value: string | null, now: number): number {
	let ms = 60_000;
	if (value !== null) {
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1_000;
		else {
			const date = Date.parse(value);
			if (!Number.isNaN(date)) ms = Math.max(0, date - now);
		}
	}
	return Math.min(ms, RETRY_AFTER_CAP_MS);
}

export function createUsageClient(deps: {
	fetchImpl: typeof fetch;
	timeoutMs?: number;
	nowFn?: () => number;
	maxBodyBytes?: number;
	userAgent?: string;
}): UsageClientLike {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;
	const now = () => (deps.nowFn ?? Date.now)();
	const userAgent = deps.userAgent ?? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`;
	let consecutiveAuthFailures = 0;
	let authLatch = false;

	async function getJson(url: string, token: string, signal: AbortSignal | undefined): Promise<{ status: number; ok: boolean; text: string; headers: Record<string, string> }> {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await deps.fetchImpl(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"User-Agent": userAgent,
				},
				signal: combined,
				redirect: "manual",
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const wasTimeout = timeoutSignal.aborted || (signal?.aborted ?? false);
			throw new UsageError(wasTimeout ? "timeout" : "transient", redactError(`fetch failed: ${reason}`, [token]));
		}
		const text = await readBoundedBody(response, maxBodyBytes, signal).catch(() => "");
		const headers: Record<string, string> = {};
		response.headers.forEach((v, k) => { headers[k] = v; });
		return { status: response.status, ok: response.ok, text, headers };
	}

	return {
		async fetchSnapshot(token, signal) {
			if (authLatch) return { status: "error", code: "auth", message: "credential rejected; paused" };
			const warnings: string[] = [];

			let keyResp: { status: number; ok: boolean; text: string; headers: Record<string, string> };
			try {
				keyResp = await getJson(KEY_URL, token, signal);
			} catch (error) {
				return { status: "error", code: error instanceof UsageError ? error.code : "transient", message: error instanceof Error ? error.message : String(error) };
			}
			if (keyResp.status === 401 || keyResp.status === 403) {
				consecutiveAuthFailures += 1;
				if (consecutiveAuthFailures >= 2) authLatch = true;
				return { status: "error", code: "auth", message: "the credential was rejected by OpenRouter" };
			}
			if (keyResp.status === 402) return { status: "error", code: "insufficient", message: "credit limit reached" };
			if (keyResp.status === 429) {
				const retryAfter = keyResp.headers["retry-after"] ?? keyResp.headers["Retry-After"] ?? null;
				return { status: "retry", retryAfterMs: parseRetryAfter(retryAfter, now()) };
			}
			if (keyResp.status >= 500) return { status: "error", code: "transient", message: `key endpoint failed (${keyResp.status})` };
			if (!keyResp.ok) return { status: "error", code: "transient", message: `key endpoint failed (${keyResp.status})` };

			let key: KeyStatus;
			try {
				key = parseKeyStatus(JSON.parse(keyResp.text));
			} catch {
				return { status: "error", code: "parse", message: "key endpoint returned an unexpected shape" };
			}

			let account: AccountBalance | undefined;
			let balanceUnavailable = false;
			try {
				const creditsResp = await getJson(CREDITS_URL, token, signal);
				if (creditsResp.status === 401 || creditsResp.status === 403) {
					balanceUnavailable = true;
				} else if (creditsResp.status === 402) {
					balanceUnavailable = true;
					warnings.push("credits endpoint reported 402");
				} else if (creditsResp.status === 429) {
					warnings.push("credits endpoint rate limited; balance not refreshed this cycle");
				} else if (creditsResp.status >= 500 || !creditsResp.ok) {
					warnings.push("credits endpoint unavailable this cycle");
				} else {
					try {
						account = parseCredits(JSON.parse(creditsResp.text));
					} catch {
						balanceUnavailable = true;
						warnings.push("credits endpoint returned an unexpected shape");
					}
				}
			} catch (error) {
				// Network/timeout on the balance path must not fail the snapshot.
				warnings.push(`credits fetch degraded: ${error instanceof Error ? error.message : String(error)}`);
			}

			consecutiveAuthFailures = 0;
			return {
				status: "ok",
				snapshot: {
					schemaVersion: 1,
					capturedAt: now(),
					fingerprint: fingerprintOf(key.userId, key.label),
					key,
					...(account ? { account } : {}),
					...(balanceUnavailable ? { balanceUnavailable: true } : {}),
					warnings,
				},
			};
		},
		resetBreaker() {
			consecutiveAuthFailures = 0;
			authLatch = false;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension placeholder (filled by tickets T02+)
// ─────────────────────────────────────────────────────────────────────────────
export function openRouterBalanceInstall(_pi: unknown): void {
	// Lifecycle lands in T03.
}

export default function openRouterBalance(pi: unknown): void {
	openRouterBalanceInstall(pi);
}
