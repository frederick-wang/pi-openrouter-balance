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
	const rateText = snapshot.burnRate ? ` ↓${formatBurn(snapshot.burnRate, lang)}` : "";
	let base = "";
	if (snapshot.account) {
		base = `${formatMoney(snapshot.account.balance)}`;
	} else if (snapshot.balanceUnavailable) {
		base = lang === "zh" ? `本月 ${formatMoney(snapshot.key.usageMonthly)}` : `This month ${formatMoney(snapshot.key.usageMonthly)}`;
	} else {
		return `${label} ${theme.fg("dim", msg(lang, "nA"))}`;
	}
	const capped = snapshot.key.limitRemaining != null && snapshot.key.limit != null && snapshot.key.limit > 0;
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
	if (k.limit != null) {
		const ratio = k.limitRemaining != null && k.limit > 0 ? k.limitRemaining / k.limit : 0;
		const reset = k.limitReset ? limitResetLabel(k.limitReset, lang) : "—";
		lines.push(`  ${msg(lang, "creditLimit")}: ${renderBar(ratio, identityTheme)} ${Math.round(clampPercent(ratio * 100))}% — ${msg(lang, "creditLimitDetail", { limit: formatMoney(k.limit), remaining: formatMoney(k.limitRemaining ?? 0), reset })}`);
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
		lines.push(`  ${lang === "zh" ? "消耗速率" : "Burn rate"}: ↓${formatBurn(snapshot.burnRate, lang)}`);
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
		...(opts.runwayHours != null ? { runwayHours: opts.runwayHours } : {}),
		warnings: snapshot.warnings,
	};
}


// ─────────────────────────────────────────────────────────────────────────────
// Extension placeholder (lifecycle lands in T03)
// ─────────────────────────────────────────────────────────────────────────────
export function openRouterBalanceInstall(_pi: unknown): void {
	// Lifecycle lands in T03.
}

export default function openRouterBalance(pi: unknown): void {
	openRouterBalanceInstall(pi);
}
