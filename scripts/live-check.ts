/**
 * Live verification helper (dev only — excluded from the npm file whitelist).
 *
 * Usage: pnpm run live-check
 *
 * Runs ONE read-only refresh against OpenRouter (GET /api/v1/key +
 * GET /api/v1/credits) with pi's own credential (user-authorized; never in
 * CI; no writes). Prints a redacted summary. Never prints the key.
 */

import { createUsageClient, resolveOpenRouterAuth, formatMoney } from "../extensions/openrouter-balance.ts";

const ctx = {
	modelRegistry: {
		getProviderAuth: async () => {
			// Real pi resolution at runtime; here we go through the same API the
			// extension uses.
			const mod = (await import("@earendil-works/pi-coding-agent")) as {
				readStoredCredential?: (providerId: string) => { type?: string; access?: string } | undefined;
			};
			const cred = mod.readStoredCredential?.("openrouter");
			if (cred?.type === "oauth" && typeof cred.access === "string") {
				return { auth: { apiKey: cred.access } };
			}
			const envKey = process.env["OPENROUTER_API_KEY"];
			return envKey ? { auth: { apiKey: envKey } } : undefined;
		},
	},
};

const auth = await resolveOpenRouterAuth(ctx as never);
if (auth.status !== "ok") {
	console.log(`auth       : ${auth.status}${auth.status === "auth-error" ? ` — ${auth.message}` : ""}`);
	console.log("hint       : run /login and pick OpenRouter, or set OPENROUTER_API_KEY");
	process.exit(1);
}
console.log(`token      : length ${auth.token.length} (not printed)`);

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
	console.log(`key label  : ${k.label ?? "?"}`);
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
