import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageClient, resolveOpenRouterAuth } from "../extensions/openrouter-balance.ts";
import { fakeFetch } from "./helpers.ts";

const keyPayload = {
	data: {
		label: "sk-or-v1-4f9...924",
		is_management_key: false,
		is_provisioning_key: false,
		limit: null,
		limit_reset: null,
		limit_remaining: null,
		include_byok_in_limit: false,
		usage: 0,
		usage_daily: 0,
		usage_weekly: 0,
		usage_monthly: 0,
		byok_usage: 0,
		byok_usage_daily: 0,
		byok_usage_weekly: 0,
		byok_usage_monthly: 0,
		is_free_tier: false,
		expires_at: null,
		creator_user_id: "user_2eYeg23KhxJY46RBpNKtpAWIDKh",
	},
};
const creditsPayload = { data: { total_credits: 5217.29, total_usage: 5067.59 } };

test("client: fetchSnapshot hits both endpoints with the bearer and parses", async () => {
	const fx = fakeFetch([
		{ status: 200, body: keyPayload },
		{ status: 200, body: creditsPayload },
	]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("sk-or-v1-x", undefined);
	assert.equal(res.status, "ok");
	const snap = (res as { snapshot: { key: { userId: string }; account: { balance: number } } }).snapshot;
	assert.equal(snap.key.userId, "user_2eYeg23KhxJY46RBpNKtpAWIDKh");
	assert.equal(snap.account.balance > 149 && snap.account.balance < 150, true);
	assert.equal(fx.requests.length, 2);
	assert.equal(fx.requests[0].url, "https://openrouter.ai/api/v1/key");
	assert.equal(fx.requests[1].url, "https://openrouter.ai/api/v1/credits");
	assert.equal(fx.requests[0].headers["Authorization"], "Bearer sk-or-v1-x");
	assert.equal(fx.requests[0].fetchInit?.redirect, "manual");
});

test("client: /credits 403 degrades to balanceUnavailable (not an error)", async () => {
	const fx = fakeFetch([
		{ status: 200, body: keyPayload },
		{ status: 403, body: { error: { message: "management key required" } } },
	]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("k", undefined);
	assert.equal(res.status, "ok");
	const snap = (res as { snapshot: { balanceUnavailable?: boolean; account?: unknown } }).snapshot;
	assert.equal(snap.balanceUnavailable, true);
	assert.equal(snap.account, undefined);
});

test("client: /key 401/403 is auth error and re-resolves once at the factory level only", async () => {
	for (const status of [401, 403]) {
		const fx = fakeFetch([{ status, body: { error: "nope" } }]);
		const client = createUsageClient({ fetchImpl: fx.fetch });
		const res = await client.fetchSnapshot("k", undefined);
		assert.equal(res.status, "error");
		assert.equal((res as { code: string }).code, "auth");
	}
});

test("client: 402 on either endpoint classifies insufficient", async () => {
	const fx = fakeFetch([{ status: 402, body: {} }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("k", undefined);
	assert.equal(res.status, "error");
	assert.equal((res as { code: string }).code, "insufficient");
});

test("client: 429 retries with Retry-After seconds or HTTP date", async () => {
	const fx = fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "120" } }]);
	const client = createUsageClient({ fetchImpl: fx.fetch, nowFn: () => 1_752_000_000_000 });
	const res = await client.fetchSnapshot("k", undefined);
	assert.equal(res.status, "retry");
	assert.equal((res as { retryAfterMs: number }).retryAfterMs, 120_000);
});

test("client: 5xx and network errors are transient; malformed JSON is parse", async () => {
	let fx = fakeFetch([{ status: 500, body: {} }]);
	let client = createUsageClient({ fetchImpl: fx.fetch });
	let res = await client.fetchSnapshot("k", undefined);
	assert.equal((res as { code: string }).code, "transient");

	fx = fakeFetch([{ status: 200, body: "not-json" }]);
	client = createUsageClient({ fetchImpl: fx.fetch });
	res = await client.fetchSnapshot("k", undefined);
	assert.equal((res as { code: string }).code, "parse");
});

test("client: key-only mode when the account always lacks permission keeps working", async () => {
	const fx = fakeFetch([
		{ status: 200, body: keyPayload },
		{ status: 403, body: {} },
	]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("k", undefined);
	assert.equal(res.status, "ok");
});

test("client: oversized body is a parse error; errors redact the bearer", async () => {
	const fx = fakeFetch([{ status: 200, body: "x".repeat(300 * 1024) }]);
	const client = createUsageClient({ fetchImpl: fx.fetch });
	const res = await client.fetchSnapshot("sk-or-v1-secret123", undefined);
	assert.equal((res as { code: string }).code, "parse");

	const throwing = {
		fetch: async () => {
			throw new Error("socket fail for sk-or-v1-secret123");
		},
	};
	const c2 = createUsageClient({ fetchImpl: throwing.fetch as never });
	const r2 = await c2.fetchSnapshot("sk-or-v1-secret123", undefined);
	assert.equal((r2 as { message: string }).message.includes("sk-or-v1-secret123"), false);
});

test("auth: resolveOpenRouterAuth states", async () => {
	const ok = await resolveOpenRouterAuth({ modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "sk-or-v1-x" } }) } } as never);
	assert.equal(ok.status, "ok");
	assert.equal((ok as { token: string }).token, "sk-or-v1-x");
	const none = await resolveOpenRouterAuth({ modelRegistry: { getProviderAuth: async () => undefined } } as never);
	assert.equal(none.status, "no-auth");
	const boom = await resolveOpenRouterAuth({ modelRegistry: { getProviderAuth: async () => { throw new Error("x"); } } } as never);
	assert.equal((boom as { status: string }).status, "auth-error");
});
