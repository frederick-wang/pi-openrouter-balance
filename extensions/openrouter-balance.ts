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
import { createHmac } from "node:crypto";
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
	insufficient?: boolean;
	burnRate?: BurnRate;
	keyBurnRate?: BurnRate;
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
	let creditsDenied = false;

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
			const warnings: string[] = [];

			let keyResp: { status: number; ok: boolean; text: string; headers: Record<string, string> };
			try {
				keyResp = await getJson(KEY_URL, token, signal);
			} catch (error) {
				return { status: "error", code: error instanceof UsageError ? error.code : "transient", message: error instanceof Error ? error.message : String(error) };
			}
			if (keyResp.status === 401 || keyResp.status === 403) {
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
			let insufficient = false;
			try {
				if (creditsDenied) {
					warnings.push("credits endpoint denied; key-scoped view");
				} else {
				const creditsResp = await getJson(CREDITS_URL, token, signal);
				if (creditsResp.status === 401 || creditsResp.status === 403) {
					creditsDenied = true;
					balanceUnavailable = true;
				} else if (creditsResp.status === 402) {
					insufficient = true;
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
				}
			} catch (error) {
				// Network/timeout on the balance path must not fail the snapshot.
				warnings.push(`credits fetch degraded: ${error instanceof Error ? error.message : String(error)}`);
			}

			return {
				status: "ok",
				snapshot: {
					schemaVersion: 1,
					capturedAt: now(),
					fingerprint: fingerprintOf(key.userId, key.label),
					key,
					...(account ? { account } : {}),
					...(balanceUnavailable ? { balanceUnavailable: true } : {}),
					...(insufficient ? { insufficient: true } : {}),
					warnings,
				},
			};
		},
		resetBreaker() {
			creditsDenied = false;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics: burn rate, runway, money formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface BalanceSample {
	t: number;
	balance: number;
}

const BURN_MIN_COUNT = 3;
const BURN_MIN_SPAN_MS = 3_600_000;
const MONEY_EPSILON = 1e-9;

/**
 * Burn rate from the account balance series. Balance decreases with use;
 * a top-up jumps it up and opens a new window. Walks back from the newest
 * sample while the series stays non-increasing (epsilon for float jitter),
 * requires ≥3 samples over ≥1h, and returns null without a positive drop.
 */
export function estimateBurnRate(snapshots: BalanceSample[]): BurnRate | null {
	const usable = snapshots.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.balance));
	if (usable.length < BURN_MIN_COUNT) return null;
	let start = usable.length - 1;
	while (start > 0 && usable[start - 1].balance >= usable[start].balance - MONEY_EPSILON) start -= 1;
	const window = usable.slice(start);
	if (window.length < BURN_MIN_COUNT) return null;
	const span = window[window.length - 1].t - window[0].t;
	if (span < BURN_MIN_SPAN_MS) return null;
	const drop = window[0].balance - window[window.length - 1].balance;
	if (drop <= MONEY_EPSILON) return null;
	return { perHour: (drop / span) * 3_600_000, windowHours: span / 3_600_000 };
}

/** Per-key series discriminator: HMAC(label) — stable, non-secret, distinct from account fingerprints. */
export function keyDiscriminator(label: string | undefined): string {
	return fingerprintOf(undefined, label ? `key:${label}` : "");
}

/**
 * Burn rate from a per-key usage series. Usage is monotonic per key, but
 * key switches and accounting resets can decrease it: any drop starts a new
 * segment (same walkback shape as the balance top-ups). Same gates as the
 * balance estimator PLUS a minimum absolute delta (cents quantization).
 */
export function estimateKeyBurnRate(snapshots: StoreBalanceRow[]): BurnRate | null {
	const usable = snapshots.filter((sx) => Number.isFinite(sx.t) && Number.isFinite(sx.keyUsage ?? NaN));
	if (usable.length < BURN_MIN_COUNT) return null;
	// Segment on the LAST key discriminator; drops inside a segment restart it.
	let start = usable.length - 1;
	while (
		start > 0 &&
		usable[start - 1].keyFp === usable[usable.length - 1].keyFp &&
		usable[start - 1].keyUsage! <= usable[start].keyUsage! + MONEY_EPSILON
	) start -= 1;
	const window = usable.slice(start);
	if (window.length < BURN_MIN_COUNT) return null;
	const span = window[window.length - 1].t - window[0].t;
	if (span < BURN_MIN_SPAN_MS) return null;
	const rise = window[window.length - 1].keyUsage! - window[0].keyUsage!;
	if (rise < 0.01) return null; // cent quantization floor
	return { perHour: (rise / span) * 3_600_000, windowHours: span / 3_600_000 };
}

export function runwayHours(balance: number, perHour: number): number | null {
	if (perHour <= 0 || balance < 0 || !Number.isFinite(balance) || !Number.isFinite(perHour)) return null;
	const hours = balance / perHour;
	return Number.isFinite(hours) ? hours : null;
}

/** `$12.34` / `-$2.50` — money is a number, formatting is display-only. */
export function formatMoney(amount: number): string {
	if (!Number.isFinite(amount)) return "$";
	return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `$${amount.toFixed(2)}`;
}

/** Compact money for footer bars: same rule, no padding concerns. */
export function compactMoney(amount: number): string {
	return formatMoney(amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

export type Lang = "en" | "zh";

export function resolveLang(env: Record<string, string | undefined>): Lang {
	const explicit = env["PI_OPENROUTER_BALANCE_LANG"];
	if (explicit === "zh" || explicit === "en") return explicit;
	const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type MsgVars = Record<string, string | number>;

const MESSAGES: Record<Lang, Record<string, (v: MsgVars) => string>> = {
	en: {
		reportTitle: () => "OpenRouter Balance & Usage",
		visitPage: () => `More at ${USAGE_PAGE_URL}`,
		pressClose: () => "Press Enter, Esc, or Ctrl+C to close · ↑↓ scroll",
		pressCloseShort: () => "Esc to close",
		scrollStatus: (v) => `${v.pos}/${v.total} lines · ↑↓ scroll · Enter closes`,
		accountBalance: () => "Account balance",
		balanceDetail: (v) => `purchased ${v.credits} − used ${v.usage}`,
		balanceUnavailable: () => "Account balance — (key lacks account read permission)",
		creditLimit: () => "Credit limit",
		creditLimitUnset: () => "unset (unlimited)",
		creditLimitDetail: (v) => `${v.limit} · ${v.remaining} remaining · resets ${v.reset}`,
		keyLabel: () => "Key label",
		paidAccount: () => "paid account (credits purchased)",
		freeAccount: () => "free account (no purchases yet)",
		today: () => "Today",
		thisWeek: () => "This week",
		thisMonth: () => "This month",
		byok: () => "BYOK",
		burnRate: (v) => `${v.rate}/h (${v.window})`,
		runway: (v) => `≈ ${v.days}d remaining`,
		freeModelStatus: (v) => `Current model: free model (${v.caps})`,
		freeModelCaps: () => "20 req/min · 50 req/day",
		modelPaidNote: () => "Current model: free model",
		updatedAgo: (v) => `updated ${v.age}`,
		source: (v) => `source: ${v.source}`,
		staleMark: () => "stale",
		nA: () => "n/a",
		error: () => "error",
		rateLimited: () => "rate limited",
		authError: () => "auth error",
		insufficient: () => "no credits left",
		freeModelSuffix: () => "free",
		authNeeded: () => "pi-openrouter-balance: no OpenRouter credential. Run /login and pick OpenRouter, or set OPENROUTER_API_KEY.",
		authFailed: () => "pi-openrouter-balance: usage fetch failed (credential rejected).",
		fetchFailed: () => "pi-openrouter-balance: usage fetch failed.",
		rateLimitedNotify: () => "pi-openrouter-balance: OpenRouter is rate-limiting; retry shortly.",
		jsonModeRestricted: () => "pi-openrouter-balance: --json requires TUI or print mode.",
		unknownArgs: (v) => `Unknown option: ${v.arg}. Usage: /openrouter-balance [--json|--refresh]`,
		alertLowBalance: (v) => `OpenRouter balance ${v.balance} is below ${v.threshold}.`,
		alertLowLimit: (v) => `OpenRouter remaining limit ${v.remaining} is below ${v.threshold}.`,
		alertInsufficient: () => "OpenRouter no credits left.",
		alertRecovered: () => "",
		reportSummary: (v) => `OpenRouter balance ${v.balance}`,
		ageJustNow: () => "just now",
		ageSec: (v) => `${v.n}s ago`,
		ageMin: (v) => `${v.n}m ago`,
		ageHour: (v) => `${v.n}h ago`,
	},
	zh: {
		reportTitle: () => "OpenRouter 余额与用量",
		visitPage: () => `更多信息见 ${USAGE_PAGE_URL}`,
		pressClose: () => "按 Enter、Esc 或 Ctrl+C 关闭 · ↑↓ 滚动",
		pressCloseShort: () => "Esc 关闭",
		scrollStatus: (v) => `第 ${v.pos}/${v.total} 行 · ↑↓ 滚动 · Enter 关闭`,
		accountBalance: () => "账户余额",
		balanceDetail: (v) => `充值 ${v.credits} − 已用 ${v.usage}`,
		balanceUnavailable: () => "账户余额 —（密钥无账户读取权限）",
		creditLimit: () => "额度上限",
		creditLimitUnset: () => "未设置（不限额）",
		creditLimitDetail: (v) => `${v.limit} · 剩余 ${v.remaining} · ${v.reset}重置`,
		keyLabel: () => "密钥标签",
		paidAccount: () => "付费账户（已购买额度）",
		freeAccount: () => "免费账户（从未购买额度）",
		today: () => "今日",
		thisWeek: () => "本周",
		thisMonth: () => "本月",
		byok: () => "自带密钥（BYOK）",
		burnRate: (v) => `${v.rate}/小时（近 ${v.window}）`,
		runway: (v) => `≈ 还可使用 ${v.days} 天`,
		freeModelStatus: (v) => `当前模型：免费模型（${v.caps}）`,
		freeModelCaps: () => "20 次/分 · 50 次/日",
		modelPaidNote: () => "当前模型：免费模型",
		updatedAgo: (v) => `更新于 ${v.age}`,
		source: (v) => `来源：${v.source}`,
		staleMark: () => "陈旧",
		nA: () => "n/a",
		error: () => "错误",
		rateLimited: () => "限流中",
		authError: () => "认证错误",
		insufficient: () => "额度用尽",
		freeModelSuffix: () => "免费",
		authNeeded: () => "pi-openrouter-balance：没有找到 OpenRouter 凭据。请运行 /login 选择 OpenRouter，或设置 OPENROUTER_API_KEY。",
		authFailed: () => "pi-openrouter-balance：用量获取失败（凭据被拒绝）。",
		fetchFailed: () => "pi-openrouter-balance：用量获取失败。",
		rateLimitedNotify: () => "pi-openrouter-balance：OpenRouter 限流中，稍后重试。",
		jsonModeRestricted: () => "pi-openrouter-balance：--json 只支持 TUI 或 print 模式。",
		unknownArgs: (v) => `未知选项：${v.arg}。用法：/openrouter-balance [--json|--refresh]`,
		alertLowBalance: (v) => `OpenRouter 余额 ${v.balance} 已低于 ${v.threshold}。`,
		alertLowLimit: (v) => `OpenRouter 剩余额度 ${v.remaining} 已低于 ${v.threshold}。`,
		alertInsufficient: () => "OpenRouter 额度用尽。",
		alertRecovered: () => "",
		reportSummary: (v) => `OpenRouter 余额 ${v.balance}`,
		ageJustNow: () => "刚刚",
		ageSec: (v) => `${v.n} 秒前`,
		ageMin: (v) => `${v.n} 分钟前`,
		ageHour: (v) => `${v.n} 小时前`,
	},
};

export type MsgKey = keyof typeof MESSAGES.en;

/** Test hook: en/zh catalog parity (silent en fallback must never hide drift). */
export function catalogKeyDiff(): { zhMissing: string[]; enMissing: string[]; orphanKeys: string[] } {
	const enKeys = Object.keys(MESSAGES.en);
	const zhKeys = Object.keys(MESSAGES.zh);
	return {
		zhMissing: enKeys.filter((k) => !(k in MESSAGES.zh)),
		enMissing: zhKeys.filter((k) => !(k in MESSAGES.en)),
		orphanKeys: zhKeys.filter((k) => !enKeys.includes(k)),
	};
}

export function msg(lang: Lang, key: MsgKey, vars: MsgVars = {}): string {
	const fn = MESSAGES[lang][key] ?? MESSAGES.en[key];
	return fn ? fn(vars) : key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer, report, JSON builders
// ─────────────────────────────────────────────────────────────────────────────

export interface FooterTheme {
	fg(role: string, text: string): string;
}

export const identityTheme: FooterTheme = { fg: (_role, text) => text };

const RESET_LABELS: Record<string, { en: string; zh: string }> = {
	daily: { en: "daily", zh: "每日" },
	weekly: { en: "weekly", zh: "每周" },
	monthly: { en: "monthly", zh: "每月" },
};

function limitResetLabel(cadence: string, lang: Lang): string {
	const label = RESET_LABELS[cadence.toLowerCase()];
	if (label) return label[lang] ?? label.en;
	return cadence; // unknown cadence passes through opaquely
}

export function cappedKey(k: Pick<KeyStatus, "limit" | "limitRemaining">): boolean {
	return k.limitRemaining != null && k.limit != null && k.limit > 0;
}

export function renderBar(ratio: number, theme: FooterTheme): string {
	const width = 8;
	const filled = Math.round((clampPercent(ratio * 100) / 100) * width);
	const role = remainingRatioHealth(ratio);
	return theme.fg(role, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

export function remainingRatioHealth(ratio: number): string {
	if (ratio >= 0.5) return "success";
	if (ratio >= 0.2) return "warning";
	return "error";
}

export interface FooterOpts {
	now: number;
	stale?: boolean;
	freeModel?: boolean;
	theme?: FooterTheme;
	lang?: Lang;
	burnMode?: "account" | "key";
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function formatBurn(rate: BurnRate, lang: Lang): string {
	const perHour = `${compactMoney(rate.perHour)}/h`;
	const window = rate.windowHours >= 1 ? `${rate.windowHours.toFixed(1)}h` : `${Math.round(rate.windowHours * 60)}m`;
	return lang === "zh" ? `${perHour}（近 ${window}）` : `${perHour} (${window})`;
}

export function renderFooter(snapshot: Snapshot, opts: FooterOpts): string {
	const theme = opts.theme ?? identityTheme;
	const lang = opts.lang ?? "en";
	const label = "openrouter";
	const burnMode = (opts.burnMode ?? "account");
	const burn = burnMode === "key" ? (snapshot.keyBurnRate ?? snapshot.burnRate) : (snapshot.burnRate ?? snapshot.keyBurnRate);
	const rateText = burn ? ` ↓${formatBurn(burn, lang)}` : "";
	let base = "";
	if (snapshot.account) {
		base = `${formatMoney(snapshot.account.balance)}`;
	} else if (snapshot.balanceUnavailable) {
		base = lang === "zh" ? `本月 ${formatMoney(snapshot.key.usageMonthly)}` : `This month ${formatMoney(snapshot.key.usageMonthly)}`;
	} else {
		return `${label} ${theme.fg("dim", msg(lang, "nA"))}`;
	}
	const capped = cappedKey(snapshot.key);
	let body = base;
	if (capped) {
		const ratio = snapshot.key.limitRemaining! / snapshot.key.limit!;
		body += ` ${renderBar(ratio, theme)} ${Math.round(clampPercent(ratio * 100))}% ${compactMoney(snapshot.key.limitRemaining!)}/${compactMoney(snapshot.key.limit!)}`;
	}
	let out = `${label} ${body}${rateText}`;
	if (opts.stale) out = `${label} ~${body}${rateText}`;
	if (opts.freeModel) out += lang === "zh" ? " ·免费" : " ·free";
	return out;
}

function formatRunway(hours: number, lang: Lang): string {
	if (hours >= 24) {
		const days = hours / 24;
		return lang === "zh" ? `≈ 还可使用 ${days.toFixed(1)} 天` : `≈ ${days.toFixed(1)}d remaining`;
	}
	return lang === "zh" ? `≈ 还可使用 ${hours.toFixed(1)} 小时` : `≈ ${hours.toFixed(1)}h remaining`;
}

function formatAge(ms: number, lang: Lang): string {
	if (ms < 5_000) return msg(lang, "ageJustNow");
	if (ms < 60_000) return msg(lang, "ageSec", { n: Math.round(ms / 1_000) });
	if (ms < 3_600_000) return msg(lang, "ageMin", { n: Math.round(ms / 60_000) });
	return msg(lang, "ageHour", { n: Math.round(ms / 3_600_000) });
}

export interface ReportOpts {
	now: number;
	lang: Lang;
	stale?: boolean;
	freeModel?: boolean;
	runwayHours?: number | null;
}

export function buildReportLines(snapshot: Snapshot, opts: ReportOpts): string[] {
	const lines: string[] = [];
	const lang = opts.lang;
	const age = formatAge(Math.max(0, opts.now - snapshot.capturedAt), lang);
	lines.push(msg(lang, "updatedAgo", { age }) + (opts.stale ? ` (~)` : "") + ` · ${msg(lang, "source", { source: "API" })}`);
	lines.push("");
	if (snapshot.account) {
		lines.push(`  ${msg(lang, "accountBalance")}: ${formatMoney(snapshot.account.balance)}`);
		lines.push(`    ${msg(lang, "balanceDetail", { credits: formatMoney(snapshot.account.totalCredits), usage: formatMoney(snapshot.account.totalUsage) })}`);
	} else if (snapshot.balanceUnavailable) {
		lines.push(`  ${msg(lang, "accountBalance")}: ${msg(lang, "balanceUnavailable")}`);
	}
	const k = snapshot.key;
	if (cappedKey(k)) {
		const ratio = k.limitRemaining! / k.limit!;
		const reset = k.limitReset ? limitResetLabel(k.limitReset, lang) : "—";
		lines.push(`  ${msg(lang, "creditLimit")}: ${renderBar(ratio, identityTheme)} ${Math.round(clampPercent(ratio * 100))}% — ${msg(lang, "creditLimitDetail", { limit: formatMoney(k.limit!), remaining: formatMoney(k.limitRemaining!), reset })}`);
	} else if (k.limit != null) {
		lines.push(`  ${msg(lang, "creditLimit")}: ${formatMoney(k.limit)} — ${msg(lang, "nA")}`);
	} else {
		lines.push(`  ${msg(lang, "creditLimit")}: ${msg(lang, "creditLimitUnset")}`);
	}
	const accountNote = k.freeTier ? msg(lang, "freeAccount") : msg(lang, "paidAccount");
	lines.push(`  ${msg(lang, "keyLabel")}: ${k.label ?? "—"} · ${accountNote}`);
	lines.push(`  ${msg(lang, "today")} ${formatMoney(k.usageDaily)} · ${msg(lang, "thisWeek")} ${formatMoney(k.usageWeekly)} · ${msg(lang, "thisMonth")} ${formatMoney(k.usageMonthly)} (UTC)`);
	if (k.byokUsage && k.byokUsage > 0) {
		lines.push(`  ${msg(lang, "byok")}: ${formatMoney(k.byokUsage)}`);
	}
	if (snapshot.burnRate) {
		lines.push(`  ${lang === "zh" ? "账户消耗速率" : "Account burn rate"}: ↓${formatBurn(snapshot.burnRate, lang)}${lang === "zh" ? "（含全部密钥与网页端）" : " (all keys + web)"}`);
	}
	if (snapshot.keyBurnRate) {
		lines.push(`  ${lang === "zh" ? "密钥消耗速率" : "Key burn rate"}: ↓${formatBurn(snapshot.keyBurnRate, lang)}${lang === "zh" ? "（该密钥所有调用者）" : " (all callers of this key)"}`);
	}
	if (opts.runwayHours != null && opts.runwayHours > 0) {
		lines.push(`  ${lang === "zh" ? "余额可用时长" : "Runway"}: ${formatRunway(opts.runwayHours, lang)}`);
	}
	if (opts.freeModel) {
		const caps = k.freeTier ? msg(lang, "freeModelCaps") : "";
		lines.push(`  ${lang === "zh" ? "模型状态" : "Model"}: ${caps ? msg(lang, "freeModelStatus", { caps }) : msg(lang, "modelPaidNote")}`);
	}
	if (snapshot.warnings.length > 0) {
		lines.push("");
		for (const w of snapshot.warnings) lines.push(`  · ${w}`);
	}
	lines.push("");
	lines.push(msg(lang, "visitPage"));
	return lines;
}

/** Stable English-key JSON payload; never credentials or fingerprints. */
export function toJsonPayload(snapshot: Snapshot, opts: { stale?: boolean; runwayHours?: number | null }): unknown {
	return {
		schemaVersion: snapshot.schemaVersion,
		capturedAt: snapshot.capturedAt,
		freshness: opts.stale ? "stale" : "fresh",
		...(snapshot.account
			? { balance: { totalCredits: snapshot.account.totalCredits, totalUsage: snapshot.account.totalUsage, balance: snapshot.account.balance } }
			: {}),
		...(snapshot.balanceUnavailable ? { balanceUnavailable: true } : {}),
		key: {
			...(snapshot.key.label ? { label: snapshot.key.label } : {}),
			...(snapshot.key.limit != null ? { limit: snapshot.key.limit } : {}),
			...(snapshot.key.limitReset ? { limitReset: snapshot.key.limitReset } : {}),
			...(snapshot.key.limitRemaining != null ? { limitRemaining: snapshot.key.limitRemaining } : {}),
			...(snapshot.key.includeByokInLimit !== undefined ? { includeByokInLimit: snapshot.key.includeByokInLimit } : {}),
			usage: snapshot.key.usage,
			usageDaily: snapshot.key.usageDaily,
			usageWeekly: snapshot.key.usageWeekly,
			usageMonthly: snapshot.key.usageMonthly,
			...(snapshot.key.byokUsage !== undefined ? { byokUsage: snapshot.key.byokUsage } : {}),
			...(snapshot.key.byokUsageDaily !== undefined ? { byokUsageDaily: snapshot.key.byokUsageDaily } : {}),
			...(snapshot.key.byokUsageWeekly !== undefined ? { byokUsageWeekly: snapshot.key.byokUsageWeekly } : {}),
			...(snapshot.key.byokUsageMonthly !== undefined ? { byokUsageMonthly: snapshot.key.byokUsageMonthly } : {}),
			freeTier: snapshot.key.freeTier,
			...(snapshot.key.expiresAt ? { expiresAt: snapshot.key.expiresAt } : {}),
		},
		...(snapshot.burnRate ? { burnRate: { perHour: snapshot.burnRate.perHour, windowHours: snapshot.burnRate.windowHours } } : {}),
		...(snapshot.keyBurnRate ? { keyBurnRate: { perHour: snapshot.keyBurnRate.perHour, windowHours: snapshot.keyBurnRate.windowHours } } : {}),
		...(opts.runwayHours != null ? { runwayHours: opts.runwayHours } : {}),
		warnings: snapshot.warnings,
	};
}


// ─────────────────────────────────────────────────────────────────────────────
// Terminal text helpers (ported from the pi-xai-usage overlay contract)
// ─────────────────────────────────────────────────────────────────────────────

export function visualWidth(s: string): number {
	let w = 0;
	for (let i = 0; i < s.length; ) {
		const cp = s.codePointAt(i) ?? 0;
		if (cp === 0x1b) {
			i = skipEscape(s, i);
			continue;
		}
		w += isWideChar(cp) ? 2 : 1;
		i += cp > 0xffff ? 2 : 1;
	}
	return w;
}

function skipEscape(s: string, i: number): number {
	if (s[i + 1] === "]") {
		let j = i + 2;
		while (j < s.length) {
			const b = s.charCodeAt(j);
			if (b === 0x07) {
				j += 1;
				break;
			}
			if (b === 0x1b && s[j + 1] === "\\") {
				j += 2;
				break;
			}
			j += 1;
		}
		return j;
	}
	let j = i + 1;
	while (j < s.length) {
		const b = s.charCodeAt(j);
		if (b >= 0x40 && b <= 0x7e && b !== 0x5b && b !== 0x5d) {
			j += 1;
			break;
		}
		j += 1;
	}
	return j;
}

function isWideChar(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

export function wrapLines(lines: string[], width: number): string[] {
	if (width <= 0) return [...lines];
	const out: string[] = [];
	for (const line of lines) {
		if (visualWidth(line) <= width) {
			out.push(line);
			continue;
		}
		const tokens = ansiTokens(line);
		const wrapped: string[] = [];
		let cur = "";
		let curW = 0;
		for (const tok of tokens) {
			if (tok.ansi) {
				cur += tok.s;
				continue;
			}
			const cw = isWideChar(tok.cp) ? 2 : 1;
			if (curW + cw > width && visibleCharCount(cur) > 0) {
				wrapped.push(cur);
				cur = cw <= width ? tok.s : "";
				curW = cw <= width ? cw : 0;
			} else if (cw > width) {
				cur = "";
				curW = 0;
			} else {
				cur += tok.s;
				curW += cw;
			}
		}
		if (cur.length > 0) wrapped.push(cur);
		const { ansiPrefix } = splitAnsi(line);
		const styleOnly = ansiPrefix.replace(/\s/g, "");
		for (let k = 0; k < wrapped.length; k++) {
			out.push(k === 0 ? wrapped[k] : `${styleOnly}${wrapped[k]}`);
		}
	}
	return out;
}

function visibleCharCount(s: string): number {
	let n = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			i = skipEscape(s, i);
		} else {
			const cp = s.codePointAt(i) ?? 0;
			n += 1;
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return n;
}

function padToWidth(line: string, width: number): string {
	const cur = visualWidth(line);
	return cur >= width ? line : `${line}${String.fromCharCode(32).repeat(width - cur)}`;
}

function clampChrome(line: string, width: number): string {
	if (visualWidth(line) <= width) return line;
	const tokens = ansiTokens(line);
	let out = "";
	let w = 0;
	let sawVisible = false;
	for (const tok of tokens) {
		if (tok.ansi) {
			out += tok.s;
			continue;
		}
		const cw = isWideChar(tok.cp) ? 2 : 1;
		if (!sawVisible && tok.s.trim() === "") {
			if (w + cw > width) break;
			out += tok.s;
			w += cw;
			continue;
		}
		if (w + cw > width && w > 0) break;
		out += tok.s;
		w += cw;
		sawVisible = true;
	}
	return out;
}

interface AnsiToken {
	ansi: boolean;
	s: string;
	cp: number;
}

function ansiTokens(line: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const j = skipEscape(line, i);
			tokens.push({ ansi: true, s: line.slice(i, j), cp: 0 });
			i = j;
		} else {
			const cp = line.codePointAt(i) ?? 0;
			const ch = String.fromCodePoint(cp);
			tokens.push({ ansi: false, s: ch, cp });
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return tokens;
}

function splitAnsi(line: string): { text: string; ansiPrefix: string; ansiSuffix: string } {
	const tokens = ansiTokens(line);
	let prefix = "";
	let start = 0;
	while (start < tokens.length && (tokens[start].ansi || tokens[start].s.trim() === "")) {
		prefix += tokens[start].s;
		start += 1;
	}
	let suffix = "";
	let end = tokens.length;
	while (end > start && tokens[end - 1].ansi) {
		suffix = tokens[end - 1].s + suffix;
		end -= 1;
	}
	return { text: tokens.slice(start, end).map((t) => t.s).join(""), ansiPrefix: prefix, ansiSuffix: suffix };
}

export function clampScrollTop(scrollTop: number, bodyLength: number, avail: number): number {
	const max = Math.max(0, bodyLength - avail);
	return Math.min(Math.max(0, scrollTop), max);
}

export interface WindowResult {
	top: number;
	lines: string[];
	atEnd: boolean;
}

export function windowSlice(body: string[], scrollTop: number, avail: number): WindowResult {
	const top = clampScrollTop(scrollTop, body.length, avail);
	return {
		top,
		lines: body.slice(top, top + avail),
		atEnd: top >= Math.max(0, body.length - avail),
	};
}

export interface KeyLike {
	matches(data: string, id: string): boolean;
}

export interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface OverlayComponentOpts {
	header: string;
	body: string[];
	footer: string;
	theme: FooterTheme;
	kb: KeyLike;
	done: (value: unknown) => void;
	rowGen: () => number;
	lang: Lang;
}

export function createOverlayComponent(opts: OverlayComponentOpts): OverlayComponent {
	const { header, body, footer, theme, kb, done, rowGen, lang } = opts;
	let scrollTop = 0;
	let closed = false;
	let lastWidth = 80;
	const body0 = body[0] === "" ? body.slice(1) : body;

	const close = () => {
		if (closed) return;
		closed = true;
		done(undefined);
	};

	function maxRowsAt(): number {
		return Math.max(1, Math.floor(rowGen() * 0.8));
	}

	function layout(width: number): { avail: number; canStatus: boolean; boxed: boolean } {
		const maxRows = maxRowsAt();
		const boxed = maxRows >= 6 && width >= 8;
		const chrome = boxed ? 5 : 3;
		const avail = Math.max(0, maxRows - chrome);
		const canStatus = boxed && maxRows >= chrome + 3;
		return { avail, canStatus, boxed };
	}

	function scrollWindowAt(w: number): { bodyLines: string[]; avail: number; needsStatus: boolean } {
		const innerW = Math.max(1, w - 2);
		const bodyLines = wrapLines(body0, innerW);
		const { avail, canStatus } = layout(w);
		const needsStatus = canStatus && bodyLines.length > avail;
		const bodyAvail = needsStatus ? Math.max(0, avail - 2) : avail;
		return { bodyLines, avail: bodyAvail, needsStatus };
	}

	function renderLines(width: number): string[] {
		const w = Math.max(1, width);
		const innerW = Math.max(1, w - 2);
		const { bodyLines, avail: bodyAvail, needsStatus } = scrollWindowAt(w);
		const { boxed } = layout(w);
		const win = windowSlice(bodyLines, scrollTop, bodyAvail);
		scrollTop = win.top;
		const statusRow = needsStatus
			? clampChrome(`  ${theme.fg("muted", msg(lang, "scrollStatus", { pos: win.atEnd ? bodyLines.length : win.top + win.lines.length, total: bodyLines.length }))}`, innerW)
			: null;
		const footerText = innerW < 20 ? msg(lang, "pressCloseShort") : footer;
		const footerRow = clampChrome(`  ${theme.fg("dim", footerText)}`, innerW);
		const titleRow = clampChrome(`  ${theme.fg("accent", header)}`, innerW);
		const blocks: string[] = [""];
		blocks.push(...win.lines);
		if (statusRow) {
			blocks.push("");
			blocks.push(statusRow);
		}
		blocks.push("");
		blocks.push(footerRow);
		if (!boxed) {
			const pad = (line: string) => padToWidth(line, w);
			const out: string[] = [pad(titleRow)];
			if (win.lines.length > 0) out.push(pad(""), ...win.lines.map(pad));
			if (statusRow) out.push(pad(""), pad(statusRow));
			out.push(pad(footerRow));
			return out;
		}
		const titleStr = clampChrome(` ${theme.fg("accent", header)} `, innerW);
		const titleW = visualWidth(titleStr);
		const pad = Math.max(0, innerW - titleW);
		const topPad = Math.floor(pad / 2);
		const topPad2 = pad - topPad;
		const top = theme.fg("border", "╭") + theme.fg("border", "─".repeat(topPad)) + titleStr + theme.fg("border", "─".repeat(topPad2)) + theme.fg("border", "╮");
		const bottom = theme.fg("border", `╰${"─".repeat(Math.max(0, innerW))}╯`);
		const out: string[] = [top];
		for (const line of blocks) {
			const inner = line === "" ? " ".repeat(innerW) : padToWidth(line, innerW);
			out.push(`${theme.fg("border", "│")}${inner}${theme.fg("border", "│")}`);
		}
		out.push(bottom);
		return out;
	}

	return {
		render(width: number) {
			lastWidth = Math.max(1, width);
			return renderLines(lastWidth);
		},
		invalidate() {
			// render() recomputes everything; kept as the pi contract entry.
		},
		handleInput(data: string) {
			if (closed) return;
			if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
				close();
				return;
			}
			const w = Math.max(1, lastWidth);
			const { bodyLines, avail: bodyAvail } = scrollWindowAt(w);
			const max = Math.max(0, bodyLines.length - bodyAvail);
			if (kb.matches(data, "tui.select.up")) {
				scrollTop = clampScrollTop(scrollTop - 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.down")) {
				scrollTop = clampScrollTop(scrollTop + 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.altScreen.pageUp")) {
				scrollTop = clampScrollTop(scrollTop - Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.altScreen.pageDown")) {
				scrollTop = clampScrollTop(scrollTop + Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.altScreen.top")) {
				scrollTop = 0;
			} else if (kb.matches(data, "tui.altScreen.bottom")) {
				scrollTop = max;
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot persistence store
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreBalanceRow {
	t: number;
	fingerprint: string;
	balance: number;
	keyFp?: string;
	keyUsage?: number;
}

export interface BalanceStoreLike {
	append(row: StoreBalanceRow): void;
	load(fingerprint: string): StoreBalanceRow[];
}

export interface StoreIo {
	readFile(p: string): string | null;
	appendFile(p: string, s: string): void;
	writeFile(p: string, s: string): void;
	rename(from: string, to: string): void;
	mkdir(p: string): void;
}

export const SNAPSHOT_KEEP = 500;
export const SNAPSHOT_COMPACT_AT = 1_000;
export const SNAPSHOT_FILE_NAME = "pi-openrouter-balance-snapshots.jsonl";

function rowHygienic(raw: unknown): boolean {
	const text = JSON.stringify(raw);
	if (!text) return false;
	const lower = text.toLowerCase();
	return !lower.includes("sk-or-v") && !lower.includes("authorization") && !lower.includes("bearer") && !lower.includes("api_key");
}

export function createBalanceStore(dir: string, io: StoreIo): BalanceStoreLike {
	const file = nodePath.join(dir, SNAPSHOT_FILE_NAME);
	const parseAll = (): StoreBalanceRow[] => {
		const raw = io.readFile(file);
		if (raw === null) return [];
		const out: StoreBalanceRow[] = [];
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const r = JSON.parse(t) as unknown;
				if (!isRecord(r)) continue;
				if (typeof r["t"] !== "number" || typeof r["fingerprint"] !== "string" || typeof r["balance"] !== "number") continue;
				if (!rowHygienic(r)) continue;
				out.push({
					t: r["t"],
					fingerprint: r["fingerprint"],
					balance: r["balance"],
					...(typeof r["keyFp"] === "string" ? { keyFp: r["keyFp"] } : {}),
					...(typeof r["keyUsage"] === "number" ? { keyUsage: r["keyUsage"] } : {}),
				});
			} catch {
				// skip corrupt lines
			}
		}
		return out;
	};
	return {
		append(row) {
			try {
				io.mkdir(dir);
				const all = parseAll();
				all.push(row);
				if (all.length > SNAPSHOT_COMPACT_AT) {
					const kept = all.slice(-SNAPSHOT_KEEP);
					const tmp = `${file}.tmp`;
					io.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
					io.rename(tmp, file);
				} else {
					io.appendFile(file, JSON.stringify(row) + "\n");
				}
			} catch {
				// best effort
			}
		},
		load(fingerprint) {
			return parseAll().filter((r) => r.fingerprint === fingerprint).slice(-SNAPSHOT_KEEP);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts (balance/limit thresholds + unconditional insufficient)
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertStateV1 {
	lastBalance?: number;
	lastRemaining?: number;
	warnedBalance?: boolean;
	erroredBalance?: boolean;
	warnedLimit?: boolean;
	erroredLimit?: boolean;
	insufficientReported?: boolean;
}

export interface AlertEmission {
	kind: "low-balance" | "low-limit" | "insufficient";
	messageKey: MsgKey;
	vars: MsgVars;
}

const RECOVERY_EPSILON = 1e-6;

export function evaluateAlerts(
	prev: AlertStateV1 | null,
	next: { balance?: number; limitRemaining?: number; insufficient: boolean; thresholds: { warn: number; error: number } },
): { emitted: AlertEmission[]; state: AlertStateV1 } {
	const state: AlertStateV1 = { ...(prev ?? {}) };
	const emitted: AlertEmission[] = [];

	if (next.balance !== undefined) {
		const last = state.lastBalance;
		if (last !== undefined && next.balance > last + RECOVERY_EPSILON) {
			state.warnedBalance = false;
			state.erroredBalance = false;
		}
		if (next.balance <= next.thresholds.error) {
			if (!state.erroredBalance) emitted.push({ kind: "low-balance", messageKey: "alertLowBalance", vars: { balance: formatMoney(next.balance), threshold: formatMoney(next.thresholds.error) } });
			state.erroredBalance = true;
			state.warnedBalance = true;
		} else if (next.balance <= next.thresholds.warn) {
			if (!state.warnedBalance) emitted.push({ kind: "low-balance", messageKey: "alertLowBalance", vars: { balance: formatMoney(next.balance), threshold: formatMoney(next.thresholds.warn) } });
			state.warnedBalance = true;
		}
		state.lastBalance = next.balance;
	}

	if (next.limitRemaining !== undefined) {
		const last = state.lastRemaining;
		if (last !== undefined && next.limitRemaining > last + RECOVERY_EPSILON) {
			state.warnedLimit = false;
			state.erroredLimit = false;
		}
		if (next.limitRemaining <= next.thresholds.error) {
			if (!state.erroredLimit) emitted.push({ kind: "low-limit", messageKey: "alertLowLimit", vars: { remaining: formatMoney(next.limitRemaining), threshold: formatMoney(next.thresholds.error) } });
			state.erroredLimit = true;
			state.warnedLimit = true;
		} else if (next.limitRemaining <= next.thresholds.warn) {
			if (!state.warnedLimit) emitted.push({ kind: "low-limit", messageKey: "alertLowLimit", vars: { remaining: formatMoney(next.limitRemaining), threshold: formatMoney(next.thresholds.warn) } });
			state.warnedLimit = true;
		}
		state.lastRemaining = next.limitRemaining;
	}

	if (next.insufficient && state.insufficientReported !== true) {
		emitted.push({ kind: "insufficient", messageKey: "alertInsufficient", vars: {} });
		state.insufficientReported = true;
	} else if (!next.insufficient) {
		state.insufficientReported = false;
	}

	return { emitted, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension factory and default wiring
// ─────────────────────────────────────────────────────────────────────────────

export type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

export interface UiLike {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	theme: FooterTheme;
	custom?(
		factory: (tui: unknown, theme: FooterTheme, kb: KeyLike, done: (value: unknown) => void) => OverlayComponent,
		options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } },
	): Promise<unknown>;
}

export interface ExtensionDeps {
	env?: Record<string, string | undefined>;
	nowFn?: () => number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	interactive?: (ctx: CtxLike) => boolean;
	clientFor(): UsageClientLike;
	authFor(ctx: CtxLike): Promise<AuthResolution>;
	store?: BalanceStoreLike;
	warnThreshold?: () => number;
	errorThreshold?: () => number;
}

const REFRESH_DEBOUNCE_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const STALE_HARD_MS = 10 * 60_000;
const DEFAULT_WARN = 20;
const DEFAULT_ERROR = 5;

interface ExtensionState {
	active: boolean;
	snapshot: Snapshot | null;
	stale: boolean;
	fingerprint: string | null;
	authInvalid: boolean;
	insufficient: boolean;
	retryDeadline: number;
	nextAllowedAt: number;
	inFlight: boolean;
	generation: number;
	lastError: string | null;
	lastOkFetchAt: number;
	alertState: AlertStateV1 | null;
	lastCtx: CtxLike | null;
}

function isOpenRouterProvider(model: { provider?: string } | null | undefined): boolean {
	return model?.provider === PROVIDER_ID;
}

export function createExtension(deps: ExtensionDeps) {
	const now = () => (deps.nowFn ?? Date.now)();
	const setTimeoutImpl = deps.setTimeout ?? setTimeout;
	const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;
	const setIntervalImpl = deps.setInterval ?? setInterval;
	const clearIntervalImpl = deps.clearInterval ?? clearInterval;
	const isInteractive = (ctx: CtxLike) => deps.interactive?.(ctx) ?? ctx.mode === "tui";
	const lang = resolveLang(deps.env ?? {});
	const store = deps.store ?? { append() { /* */ }, load: () => [] };
	const warnThreshold = () => {
		if (deps.warnThreshold) return deps.warnThreshold();
		const v = Number(deps.env?.["PI_OPENROUTER_BALANCE_WARN"]);
		return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WARN;
	};
	const errorThreshold = () => {
		if (deps.errorThreshold) return deps.errorThreshold();
		const v = Number(deps.env?.["PI_OPENROUTER_BALANCE_ERROR"]);
		return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ERROR;
	};

	return function install(pi: unknown): void {
		const s: ExtensionState = {
			active: false,
			snapshot: null,
			stale: false,
			fingerprint: null,
			authInvalid: false,
			insufficient: false,
			retryDeadline: 0,
			nextAllowedAt: 0,
			inFlight: false,
			generation: 0,
			lastError: null,
			lastOkFetchAt: 0,
			alertState: null,
			lastCtx: null,
		};

		const api = pi as {
			on(event: string, handler: (event: unknown, ctx: CtxLike) => Promise<void> | void): void;
			registerCommand(name: string, opts: { description: string; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null; handler: (args: string, ctx: CtxLike) => Promise<void> | void }): void;
		};

		let heartbeatTimer: TimerHandle | null = null;
		let debounceTimer: TimerHandle | null = null;
		let retryOneShot: TimerHandle | null = null;

		const clearTimers = () => {
			if (heartbeatTimer) { clearIntervalImpl(heartbeatTimer as never); heartbeatTimer = null; }
			if (debounceTimer) { clearTimeoutImpl(debounceTimer as never); debounceTimer = null; }
			if (retryOneShot) { clearTimeoutImpl(retryOneShot as never); retryOneShot = null; }
		};

		function footerText(): string {
			if (!s.active) return "";
			const label = "openrouter";
			const theme = (s.lastCtx?.ui as UiLike | undefined)?.theme ?? identityTheme;
			if (s.insufficient) return `${label} ${theme.fg("error", msg(lang, "insufficient"))}`;
			if (s.authInvalid) return `${label} ${theme.fg("error", msg(lang, "authError"))}`;
			if (!s.snapshot) {
				if (now() < s.retryDeadline) return `${label} ${theme.fg("dim", msg(lang, "rateLimited"))}`;
				if (s.lastError) return `${label} ${theme.fg("error", msg(lang, "error"))}`;
				return `${label} ${theme.fg("dim", msg(lang, "nA"))}`;
			}
			if (s.stale && now() - s.lastOkFetchAt > STALE_HARD_MS) return `${label} ${theme.fg("error", msg(lang, "error"))}`;
			const out = renderFooter(s.snapshot, {
				now: now(),
				stale: s.stale,
				freeModel: s.lastCtx?.model?.id?.toLowerCase().endsWith(":free") === true,
				theme,
				lang,
				burnMode: (deps.env?.["PI_OPENROUTER_BALANCE_BURN"] === "key" ? "key" : "account"),
			});
			return s.insufficient ? `${label} ${theme.fg("error", msg(lang, "insufficient"))}` : out;
		}

		function render(): void {
			const ui = s.lastCtx?.ui as UiLike | undefined;
			if (!ui) return;
			if (!s.active) {
				ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			ui.setStatus(STATUS_KEY, footerText());
		}

		const startHeartbeat = () => {
			if (heartbeatTimer || !s.active) return;
			heartbeatTimer = setIntervalImpl(() => {
				if (s.active && s.lastCtx) void refresh(s.lastCtx, false);
			}, HEARTBEAT_MS) as TimerHandle;
			heartbeatTimer.unref?.();
		};

		const scheduleDebouncedRefresh = (ctx: CtxLike) => {
			if (debounceTimer) return;
			debounceTimer = setTimeoutImpl(() => {
				debounceTimer = null;
				if (s.active && isInteractive(ctx)) void refresh(ctx, false);
			}, REFRESH_DEBOUNCE_MS) as TimerHandle;
			debounceTimer.unref?.();
		};

		const scheduleRetryOneShot = (ctx: CtxLike) => {
			const delay = Math.max(1_000, s.retryDeadline - now());
			if (retryOneShot) {
				// Re-arm with the (possibly extended) deadline.
				clearTimeoutImpl(retryOneShot as never);
				retryOneShot = null;
			}
			retryOneShot = setTimeoutImpl(() => {
				retryOneShot = null;
				if (s.active && isInteractive(ctx)) void refresh(ctx, false);
			}, delay) as TimerHandle;
			retryOneShot.unref?.();
		};

		function emitAlerts(ctx: CtxLike): void {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui) return;
			const snap = s.snapshot;
			// Free accounts never purchased: balance 0/negative must not raise
			// low-balance alerts (ADR-0005); insufficient still applies.
			const balance =
				snap?.account && !(snap.key.freeTier && snap.account.totalCredits === 0)
					? snap.account.balance
					: undefined;
			const limitRemaining = snap?.key.limitRemaining ?? undefined;
			const { emitted, state } = evaluateAlerts(s.alertState, {
				...(balance !== undefined ? { balance } : {}),
				...(limitRemaining !== undefined ? { limitRemaining } : {}),
				insufficient: s.insufficient,
				thresholds: { warn: warnThreshold(), error: errorThreshold() },
			});
			s.alertState = state;
			for (const e of emitted) {
				ui.notify(msg(lang, e.messageKey, e.vars), e.kind === "insufficient" ? "error" : e.kind === "low-balance" && e.vars.threshold === formatMoney(errorThreshold()) ? "error" : "warning");
			}
		}

		async function refresh(ctx: CtxLike, force: boolean): Promise<void> {
			if (!isInteractive(ctx) || !s.active || s.inFlight) return;
			if (!force && now() < s.retryDeadline) return;
			if (!force && now() < s.nextAllowedAt) return;
			s.inFlight = true;
			const gen = s.generation;
			let authRetried = false;
			try {
				const auth = await deps.authFor(ctx);
				if (gen !== s.generation) return;
				if (auth.status !== "ok") {
					s.authInvalid = auth.status === "auth-error";
					s.lastError = auth.status === "no-auth" ? null : "auth";
					if (s.snapshot) s.stale = true;
					if (s.authInvalid && !s.snapshot) s.lastError = "auth";
					render();
					return;
				}
				const result = await deps.clientFor().fetchSnapshot(auth.token, ctxSignal(ctx));
				if (gen !== s.generation) return;
				if (result.status === "ok") {
					if (s.insufficient && result.snapshot.insufficient !== true) {
						// recovered: re-arm
						void 0;
					}
					s.retryDeadline = 0;
					s.authInvalid = false;
					s.lastError = null;
					s.insufficient = result.snapshot.insufficient === true;
					deps.clientFor().resetBreaker();
					const snap = result.snapshot;
					// fingerprint switch: drop burn history and rebase
					if (s.fingerprint !== null && s.fingerprint !== snap.fingerprint) {
						s.alertState = null;
					}
					s.fingerprint = snap.fingerprint;
					s.snapshot = snap;
					s.stale = false;
					s.lastOkFetchAt = now();
					if (snap.key.userId && snap.account) store.append({ t: now(), fingerprint: snap.fingerprint, balance: snap.account.balance });
					const series = snap.key.userId ? store.load(snap.fingerprint) : [];
					const rate = snap.key.userId ? estimateBurnRate(series) : null;
					s.snapshot = rate ? { ...snap, burnRate: rate } : snap;
					emitAlerts(ctx);
				} else if (result.status === "retry") {
					s.retryDeadline = Math.max(s.retryDeadline, now() + result.retryAfterMs);
					s.nextAllowedAt = Math.max(s.nextAllowedAt, s.retryDeadline);
					s.lastError = "rate-limit";
					if (s.snapshot) s.stale = true;
					scheduleRetryOneShot(ctx);
				} else {
					if (result.code === "auth") {
						if (!authRetried) {
							authRetried = true;
							const retryAuth = await deps.authFor(ctx);
							if (gen !== s.generation) return;
							if (retryAuth.status === "ok") {
								const retry = await deps.clientFor().fetchSnapshot(retryAuth.token, ctxSignal(ctx));
								if (gen !== s.generation) return;
								if (retry.status === "ok") {
									s.retryDeadline = 0;
									s.authInvalid = false;
									s.lastError = null;
									s.snapshot = retry.snapshot;
									s.stale = false;
									s.lastOkFetchAt = now();
									s.fingerprint = retry.snapshot.fingerprint;
									if (retry.snapshot.account) store.append({ t: now(), fingerprint: retry.snapshot.fingerprint, balance: retry.snapshot.account.balance });
									emitAlerts(ctx);
									render();
									return;
								}
							}
						}
						s.authInvalid = true;
						s.lastError = "auth";
						s.nextAllowedAt = now() + 60_000;
						if (s.snapshot) s.stale = true;
					} else if (result.code === "insufficient") {
						s.insufficient = true;
						s.lastError = "insufficient";
					} else {
						s.nextAllowedAt = now() + Math.min(1_000 * 2 ** 5, 60_000);
						s.lastError = result.code;
						if (s.snapshot) s.stale = true;
					}
					emitAlerts(ctx);
				}
				render();
			} catch (error) {
				if (gen !== s.generation) return;
				if (isStaleCtxReason(error)) return;
				if (s.snapshot) s.stale = true;
				render();
			} finally {
				if (gen === s.generation) s.inFlight = false;
			}
		}

		function isStaleCtxReason(error: unknown): boolean {
			return error instanceof Error && (error.message.includes("ctx is stale") || error.message.includes("stale after session"));
		}

		function ctxSignal(ctx: CtxLike): AbortSignal | undefined {
			return (ctx as { signal?: AbortSignal }).signal;
		}

		async function activate(ctx: CtxLike, modelFromEvent?: { provider?: string; id?: string } | null): Promise<void> {
			s.lastCtx = ctx;
			const model = modelFromEvent ?? ctx.model ?? null;
			if (!isOpenRouterProvider(model)) {
				s.active = false;
				s.snapshot = null;
				s.stale = false;
				clearTimers();
				render();
				return;
			}
			if (!isInteractive(ctx)) return;
			s.active = true;
			deps.clientFor().resetBreaker();
			render();
			startHeartbeat();
			void refresh(ctx, true);
		}

		api.on("session_start", async (_event, ctx) => {
			if (!isInteractive(ctx)) return;
			await activate(ctx);
		});
		api.on("model_select", async (event, ctx) => {
			s.generation += 1;
			s.inFlight = false;
			const model = (event as { model?: { provider?: string; id?: string } }).model;
			s.lastCtx = ctx;
			if (!isInteractive(ctx)) return;
			await activate(ctx, model);
		});
		api.on("agent_settled", async (_event, ctx) => {
			if (!isInteractive(ctx) || !s.active) return;
			scheduleDebouncedRefresh(ctx);
		});
		api.on("agent_end", async (_event, ctx) => {
			if (!isInteractive(ctx) || !s.active) return;
			scheduleDebouncedRefresh(ctx);
		});
		api.on("after_provider_response", async (event, ctx) => {
			if (!isInteractive(ctx) || !s.active) return;
			if (ctx.model?.provider !== PROVIDER_ID) return;
			const status = (event as { status?: number }).status;
			if (status === 402) {
				s.insufficient = true;
				s.lastError = "insufficient";
				emitAlerts(ctx);
				render();
			}
		});
		api.on("session_shutdown", async () => {
			s.generation += 1;
			s.inFlight = false;
			s.active = false;
			clearTimers();
			render();
		});

		api.registerCommand("openrouter-balance", {
			description: "Show OpenRouter account balance and key usage (add --json for raw output)",
			getArgumentCompletions: (prefix: string) => {
				const items = [
					{ value: "--json", label: "--json", description: "Stable JSON snapshot" },
					{ value: "--refresh", label: "--refresh", description: "Bypass throttling" },
				];
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			},
			handler: async (args, ctx) => {
				const ui = ctx.ui as UiLike | undefined;
				if (!ui) return;
				try {
					const parsed = parseCommandArgs(args);
					if (parsed.error) {
						ui.notify(msg(lang, "unknownArgs", { arg: parsed.error.arg }), "error");
						return;
					}
					if (parsed.json && ctx.mode !== "tui" && ctx.mode !== "print") {
						ui.notify(msg(lang, "jsonModeRestricted"), "warning");
						return;
					}
					const auth = await deps.authFor(ctx);
					if (auth.status !== "ok") {
						ui.notify(auth.status === "no-auth" ? msg(lang, "authNeeded") : msg(lang, "authFailed"), "error");
						return;
					}
					if (!parsed.refresh && now() < s.retryDeadline) {
						ui.notify(msg(lang, "rateLimitedNotify"), "error");
						return;
					}
					if (parsed.refresh) deps.clientFor().resetBreaker();
					const result = await deps.clientFor().fetchSnapshot(auth.token, ctxSignal(ctx));
					if (result.status !== "ok") {
						ui.notify(result.status === "retry" ? msg(lang, "rateLimitedNotify") : result.message || msg(lang, "fetchFailed"), "error");
						return;
					}
					const snap = result.snapshot;
					const keyFp = snap.key.label ? keyDiscriminator(snap.key.label) : undefined;
					if (snap.key.userId && snap.account) store.append({ t: now(), fingerprint: snap.fingerprint, balance: snap.account.balance, ...(keyFp ? { keyFp } : {}), ...(snap.key.usage > 0 ? { keyUsage: snap.key.usage } : {}) });
					const series = snap.key.userId ? store.load(snap.fingerprint) : [];
					const rate = snap.key.userId ? estimateBurnRate(series) : null;
					const keyRate = snap.key.userId && keyFp ? estimateKeyBurnRate(series) : null;
					const finalSnap = rate || keyRate ? { ...snap, ...(rate ? { burnRate: rate } : {}), ...(keyRate ? { keyBurnRate: keyRate } : {}) } : snap;
					if (s.active && ctx.model?.provider === PROVIDER_ID) {
						s.lastCtx = ctx;
						s.snapshot = finalSnap;
						s.stale = false;
						s.fingerprint = finalSnap.fingerprint;
						s.lastOkFetchAt = now();
						render();
					}
					const runway = finalSnap.account ? runwayHours(finalSnap.account.balance, rate?.perHour ?? 0) : null;
					if (parsed.json) {
						const payload = JSON.stringify(toJsonPayload(finalSnap, { stale: s.active ? s.stale : false, runwayHours: runway }), null, 2);
						if (ctx.mode === "tui") {
							await showOverlay(ctx, payload.split("\n"), msg(lang, "reportTitle"));
						} else if (ctx.mode === "print") {
							console.log(payload);
						} else {
							ui.notify(msg(lang, "jsonModeRestricted"), "warning");
						}
						return;
					}
					const freeModel = ctx.model?.id?.toLowerCase().endsWith(":free") === true;
					const lines = buildReportLines(finalSnap, { now: now(), lang, stale: s.active ? s.stale : false, freeModel, runwayHours: runway });
					if (ctx.mode === "tui") {
						await showOverlay(ctx, lines, msg(lang, "reportTitle"));
					} else {
						ui.notify(msg(lang, "reportSummary", { balance: finalSnap.account ? formatMoney(finalSnap.account.balance) : msg(lang, "nA") }), "info");
					}
				} catch (error) {
					if (isStaleCtxReason(error)) return;
					ui.notify(error instanceof Error ? error.message : msg(lang, "fetchFailed"), "error");
				}
			},
		});

		async function showOverlay(ctx: CtxLike, body: string[], header: string): Promise<void> {
			const ui = ctx.ui as UiLike | undefined;
			if (!ui?.custom) return;
			await ui.custom(
				(tui, theme, kb, done) => {
					const rowGen = () => (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
					return createOverlayComponent({
						header,
						body,
						footer: msg(lang, "pressClose"),
						theme,
						kb,
						done,
						rowGen,
						lang,
					});
				},
				{ overlay: true, overlayOptions: { maxHeight: "80%" } },
			);
		}
	};
}

function parseCommandArgs(args: string): { refresh: boolean; json: boolean; error?: { arg: string } } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let refresh = false;
	let json = false;
	for (const token of tokens) {
		if (token === "--refresh") refresh = true;
		else if (token === "--json") json = true;
		else return { refresh: true, json: false, error: { arg: token } };
	}
	return { refresh, json };
}

export default function openRouterBalanceInstall(pi: unknown): void {
	const env = process.env as Record<string, string | undefined>;
	const homedir = nodeOs.homedir();
	const dir = env["PI_CODING_AGENT_DIR"] ?? nodePath.join(homedir, ".pi", "agent");
	const store = createBalanceStore(dir, {
		readFile: (p) => {
			try { return nodeFs.readFileSync(p, "utf8"); } catch { return null; }
		},
		appendFile: (p, text) => {
			try { nodeFs.appendFileSync(p, text, { mode: 0o600 }); } catch { /* */ }
		},
		writeFile: (p, text) => {
			try { nodeFs.writeFileSync(p, text, { mode: 0o600 }); } catch { /* */ }
		},
		rename: (from, to) => {
			try { nodeFs.renameSync(from, to); } catch { /* */ }
		},
		mkdir: (p) => {
			try { nodeFs.mkdirSync(p, { recursive: true }); } catch { /* */ }
		},
	});
	const client = createUsageClient({ fetchImpl: fetch });
	createExtension({
		env,
		clientFor: () => client,
		authFor: (ctx) => resolveOpenRouterAuth(ctx),
		store,
	})(pi);
}
