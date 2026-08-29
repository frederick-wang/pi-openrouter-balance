/**
 * Live verification helper (dev only — excluded from the npm file whitelist).
 *
 * Usage: pnpm run live-check
 *
 * Runs ONE read-only refresh against OpenRouter (GET /api/v1/key +
 * GET /api/v1/credits) with pi's own credential (user-authorized; never in
 * CI; no writes). The token is resolved through pi's own CLI into a local
 * variable and never printed. The label is omitted from output (it can be
 * a masked key fragment).
 */

import { execFile } from "node:child_process";
import { createUsageClient, formatMoney, resolveOpenRouterAuth, type AuthResolution } from "../extensions/openrouter-balance.ts";

function resolveToken(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("pi", ["auth", "print-bearer-token", "--provider", "openrouter"], (err, stdout) => {
			if (!err && stdout && stdout.trim()) {
				resolve(stdout.trim());
				return;
			}
			const envKey = process.env["OPENROUTER_API_KEY"]?.trim();
			resolve(envKey || undefined);
		});
	});
}

const token = await resolveToken();
if (!token) {
	console.log("auth       : missing (run /login and pick OpenRouter, or set OPENROUTER_API_KEY)");
	process.exit(1);
}
console.log(`token      : length ${token.length} (not printed)`);
const auth: AuthResolution = { status: "ok", token };

const client = createUsageClient({ fetchImpl: fetch });
const result = await client.fetchSnapshot(auth.token, undefined);

if (result.status === "ok") {
	const s = result.snapshot;
	console.log(`fingerprint: ${s.fingerprint} (hmac prefix; user id not shown)`);
	if (s.account) {
		console.log(`balance    : ${formatMoney(s.account.balance)}  (purchased ${formatMoney(s.account.totalCredits)} − used ${formatMoney(s.account.totalUsage)})`);
	} else if (s.balanceUnavailable) {
		console.log(`balance    : unavailable for this key (key-scoped view remains)`);
	}
	const k = s.key;
	console.log(`free tier  : ${k.freeTier ? "free account" : "paid account"}`);
	console.log(`credit cap : ${k.limit != null ? formatMoney(k.limit) : "unset (unlimited)"}${k.limitRemaining != null ? ` — remaining ${formatMoney(k.limitRemaining)}` : ""}${k.limitReset ? ` — resets ${k.limitReset}` : ""}`);
	console.log(`usage      : all ${formatMoney(k.usage)} · today ${formatMoney(k.usageDaily)} · week ${formatMoney(k.usageWeekly)} · month ${formatMoney(k.usageMonthly)} (UTC)`);
	if (k.byokUsage && k.byokUsage > 0) console.log(`byok       : ${formatMoney(k.byokUsage)}`);
	if (s.burnRate) console.log(`burn       : ${s.burnRate.perHour.toFixed(4)}/h over ${s.burnRate.windowHours.toFixed(1)}h`);
	if (s.warnings.length > 0) {
		console.log("warnings   :");
		for (const w of s.warnings) console.log(`  - ${w}`);
	}
	console.log("schema     : ok — normalizer accepted the live payload");
	process.exit(s.warnings.length > 0 ? 2 : 0);
}
if (result.status === "retry") {
	console.log(`quota      : retry after ${result.retryAfterMs} ms`);
	process.exit(1);
}
console.log(`quota      : ${result.message}`);
process.exit(1);
