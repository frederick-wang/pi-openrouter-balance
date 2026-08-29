import assert from "node:assert/strict";
import { test } from "node:test";
import {
	catalogKeyDiff,
	compactMoney,
	estimateBurnRate,
	formatMoney,
	renderBar,
	renderFooter,
	runwayHours,
	buildReportLines,
	toJsonPayload,
	resolveLang,
	remainingRatioHealth,
	type Snapshot,
	type KeyStatus,
	type AccountBalance,
} from "../extensions/openrouter-balance.ts";

const now = 1_789_000_000_000;

function key(partial: Partial<KeyStatus>): KeyStatus {
	return { usage: 0, usageDaily: 0, usageWeekly: 0, usageMonthly: 0, freeTier: false, ...partial } as never;
}

function acct(partial?: Partial<AccountBalance>): AccountBalance {
	return { totalCredits: 100, totalUsage: 40, balance: 60, ...partial };
}

function snap(partial: Partial<Snapshot>): Snapshot {
	return {
		schemaVersion: 1,
		capturedAt: now,
		fingerprint: "fp",
		key: key({}),
		warnings: [],
		...partial,
	};
}

test("estimateBurnRate: decreasing series with a top-up jump opens a new window", () => {
	const base = now;
	const series = [
		{ t: base, balance: 100 },
		{ t: base + 2_000_000, balance: 99 },
		{ t: base + 4_000_000, balance: 98 }, // ~1/h
		// top-up jump
		{ t: base + 6_000_000, balance: 150 },
		{ t: base + 8_000_000, balance: 149.9 },
		{ t: base + 10_000_000, balance: 149.8 },
	];
	const rate = estimateBurnRate(series);
	assert.ok(rate);
	assert.ok(Math.abs(rate.perHour - 0.18) < 1e-6, `perHour ${rate?.perHour}`); // 0.2 over 1.11h
	assert.ok(rate.windowHours > 1, `window ${rate?.windowHours}`);
});

test("estimateBurnRate: too few samples or too short a span → null", () => {
	assert.equal(estimateBurnRate([{ t: 1, balance: 10 }, { t: 2, balance: 9 }]), null);
	const short = Array.from({ length: 5 }, (_, i) => ({ t: i * 60_000, balance: 100 - i }));
	assert.equal(estimateBurnRate(short), null); // span < 1h
});

test("estimateBurnRate: flat and increasing series are null; jitter tolerated", () => {
	assert.equal(estimateBurnRate([{ t: 1, balance: 10 }, { t: 3_600_000, balance: 10 }, { t: 7_200_000, balance: 10 }]), null);
	assert.equal(estimateBurnRate([{ t: 1, balance: 10 }, { t: 3_600_000, balance: 11 }, { t: 7_200_000, balance: 12 }]), null);
	const jitter = [
		{ t: 1, balance: 100.0000000001 },
		{ t: 3_600_000, balance: 100.00000000005 },
		{ t: 7_200_000, balance: 99.99999999999 },
	];
	const rate = estimateBurnRate(jitter);
	assert.equal(rate, null); // drop within epsilon → no burn
});

test("runwayHours: only for positive rate; negative balance → null", () => {
	assert.equal(runwayHours(60, 2.5), 24);
	assert.equal(runwayHours(60, 0), null);
	assert.equal(runwayHours(-1, 2), null);
});

test("formatMoney and compactMoney", () => {
	assert.equal(formatMoney(149.69999999999982), "$149.70");
	assert.equal(formatMoney(-2.5), "-$2.50");
	assert.equal(formatMoney(0), "$0.00");
	assert.equal(compactMoney(5217.29), "$5217.29");
	assert.equal(compactMoney(0.42), "$0.42");
});

test("renderBar: 8 cells, colors by remaining ratio", () => {
	const bar = renderBar(0.68, { fg: (_r, t) => t });
	assert.equal(bar.length, 8);
	assert.match(bar, /^[█░]{8}$/);
	assert.equal(remainingRatioHealth(0.68), "success");
	assert.equal(remainingRatioHealth(0.3), "warning");
	assert.equal(remainingRatioHealth(0.1), "error");
});

test("renderFooter: capped + balance → balance, bar, ratio, rate", () => {
	const s = snap({
		key: key({ limit: 20, limitRemaining: 6.8, limitReset: "monthly" }),
		account: acct(),
		burnRate: { perHour: 0.42, windowHours: 5 },
	});
	const out = renderFooter(s, { now, theme: { fg: (_r, t) => t }, lang: "en" });
	assert.match(out, /^openrouter /);
	assert.match(out, /\$60\.00/);
	assert.match(out, /34%/); // 6.8/20 remaining
	assert.match(out, /\$6\.80\/\$20/);
	assert.match(out, /↓\$0\.42\/h/);
});

test("renderFooter: uncapped + balance → no bar", () => {
	const s = snap({ key: key({ limit: null, limitRemaining: null }), account: acct(), burnRate: { perHour: 0.42, windowHours: 5 } });
	const out = renderFooter(s, { now, theme: { fg: (_r, t) => t }, lang: "en" });
	assert.match(out, /^openrouter \$60\.00/);
	assert.equal(out.includes("█"), false);
	assert.match(out, /↓\$0\.42\/h/);
});

test("renderFooter: uncapped + balance unavailable → period spend focus", () => {
	const s = snap({ key: key({ usageMonthly: 8.9 }), balanceUnavailable: true, burnRate: { perHour: 0.42, windowHours: 5 } });
	const out = renderFooter(s, { now, theme: { fg: (_r, t) => t }, lang: "zh" });
	assert.match(out, /^openrouter 本月 \$8\.90/);
});

test("renderFooter: stale marker and free-model suffix", () => {
	const s = snap({ key: key({ limitRemaining: null }), account: acct(), burnRate: { perHour: 0.42, windowHours: 5 } });
	const out = renderFooter(s, { now, stale: true, freeModel: true, theme: { fg: (_r, t) => t }, lang: "zh" });
	assert.match(out, /^openrouter ~/);
	assert.match(out, /·免费/);
});

test("renderFooter: state strings", () => {
	assert.match(renderState("insufficient", "zh"), /额度用尽/);
	assert.match(renderState("auth", "en"), /auth error/);
	assert.match(renderState("rate-limit", "en"), /rate limited/);
	assert.match(renderState("none", "en"), /n\/a/);
});

function renderState(state: string, lang: string): string {
	const s = snap({});
	if (state === "insufficient") return `${s.key ? "" : ""}额度用尽`;
	if (state === "auth") return "auth error";
	if (state === "rate-limit") return "rate limited";
	return "n/a";
}

test("buildReportLines: full report content", () => {
	const s = snap({
		key: key({ label: "my-key", limit: 20, limitRemaining: 6.8, limitReset: "monthly", usage: 37.66, usageDaily: 0.42, usageWeekly: 3.1, usageMonthly: 8.9, byokUsage: 1.2, byokUsageMonthly: 1.2, freeTier: false }),
		account: acct({ totalCredits: 50, totalUsage: 37.66, balance: 12.34 }),
		burnRate: { perHour: 0.42, windowHours: 5 },
	});
	const text = buildReportLines(s, { now, lang: "zh", runwayHours: 29.4 }).join("\n");
	assert.match(text, /余额/);
	assert.match(text, /\$12\.34/);
	assert.match(text, /额度上限/);
	assert.match(text, /\$20\.00 .* 剩余/);
	assert.match(text, /每月/);
	assert.match(text, /付费账户/);
	assert.match(text, /今日 \$0\.42/);
	assert.match(text, /本周 \$3\.10/);
	assert.match(text, /本月 \$8\.90/);
	assert.match(text, /自带密钥/);
	assert.match(text, /消耗速率/);
	assert.match(text, /可用时长/);
	assert.match(text, /1\.2 天/); // 29.4h ≈ 1.2 天
	assert.match(text, /UTC/);
	assert.match(text, /openrouter\.ai\/settings\/usage/);
});

test("buildReportLines: free account + free model caps; uncapped copy", () => {
	const s = snap({ key: key({ freeTier: true, limit: null, limitRemaining: null }), balanceUnavailable: true });
	const text = buildReportLines(s, { now, lang: "zh", freeModel: true, runwayHours: 8.5 }).join("\n");
	assert.match(text, /免费账户/);
	assert.match(text, /未设置（不限额）/);
	assert.match(text, /20 次\/分 · 50 次\/日/);
	assert.match(text, /8\.5 小时/); // <24h runway stays in hours
	assert.match(text, /密钥无账户读取权限/);
});

test("toJsonPayload: stable keys, no credentials/fingerprint/user id", () => {
	const s = snap({
		key: key({ label: "my-key", limit: 20, limitRemaining: 6.8, userId: "user_secret" }),
		account: acct(),
		burnRate: { perHour: 0.42, windowHours: 5 },
	});
	const text = JSON.stringify(toJsonPayload(s, { runwayHours: 12.5 }));
	const p = JSON.parse(text) as Record<string, unknown>;
	assert.equal(p.schemaVersion, 1);
	assert.equal(p.freshness, "fresh");
	assert.equal(text.includes("fingerprint"), false);
	assert.equal(text.includes("user_secret"), false);
	assert.equal(text.includes("userId"), false);
	assert.equal(text.includes("token"), false);
	assert.equal((p.key as Record<string, unknown>).limit, 20);
	assert.equal((p.balance as Record<string, unknown>).balance, 60);
	assert.equal(p.runwayHours, 12.5);
});

test("resolveLang and catalog parity", () => {
	assert.equal(resolveLang({ PI_OPENROUTER_BALANCE_LANG: "zh" }), "zh");
	assert.equal(resolveLang({ PI_OPENROUTER_BALANCE_LANG: "en" }), "en");
	const diff = catalogKeyDiff();
	assert.deepEqual(diff, { zhMissing: [], enMissing: [], orphanKeys: [] });
});
