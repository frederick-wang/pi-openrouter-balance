import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fingerprintOf,
	parseCredits,
	parseKeyStatus,
	parseLimitReset,
	UsageError,
	SNAPSHOT_SALT_PREFIX,
} from "../extensions/openrouter-balance.ts";

const liveKeyPayload = {
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
		rate_limit: { requests: -1, interval: "10s", note: "deprecated, ignore" },
	},
};

test("parseKeyStatus: live schema maps fully", () => {
	const k = parseKeyStatus(liveKeyPayload);
	assert.equal(k.label?.startsWith("sk-or-v1"), true);
	assert.equal(k.isManagementKey, false);
	assert.equal(k.limit, null);
	assert.equal(k.limitRemaining, null);
	assert.equal(k.usage, 0);
	assert.equal(k.usageMonthly, 0);
	assert.equal(k.byokUsage, 0);
	assert.equal(k.freeTier, false);
	assert.equal(k.expiresAt, undefined); // expires_at null → omitted
	assert.equal(k.userId, "user_2eYeg23KhxJY46RBpNKtpAWIDKh");
});

test("parseKeyStatus: capped key with reset cadence and string numbers", () => {
	const k = parseKeyStatus({
		data: {
			label: "my-key",
			limit: "20",
			limit_reset: "monthly",
			limit_remaining: "6.80",
			include_byok_in_limit: true,
			usage: 13.2,
			usage_daily: 0.42,
			usage_weekly: 3.1,
			usage_monthly: 8.9,
			byok_usage: 1.2,
			byok_usage_daily: 0.1,
			byok_usage_weekly: 1.0,
			byok_usage_monthly: 1.2,
			is_free_tier: true,
			expires_at: "2027-01-01T00:00:00Z",
			creator_user_id: "user_x",
		},
	});
	assert.equal(k.limit, 20);
	assert.equal(k.limitReset, "monthly");
	assert.equal(k.limitRemaining, 6.8);
	assert.equal(k.includeByokInLimit, true);
	assert.equal(k.byokUsageMonthly, 1.2);
	assert.equal(k.freeTier, true);
	assert.equal(k.expiresAt, "2027-01-01T00:00:00Z");
});

test("parseKeyStatus: tolerant of unknown new fields, hostile labels sanitized", () => {
	const k = parseKeyStatus({
		data: {
			label: "\x1b[31mmine\x1b[0m".repeat(30),
			usage: 1,
			usage_daily: 1,
			usage_weekly: 1,
			usage_monthly: 1,
			is_free_tier: false,
			creator_user_id: "user_y",
			some_future_field: { nested: [1, 2, 3] },
		},
	});
	assert.equal(k.label?.includes("\x1b"), false);
	assert.ok((k.label?.length ?? 0) <= 160);
	assert.equal(k.userId, "user_y");
});

test("parseKeyStatus: missing required fields throws UsageError parse", () => {
	for (const bad of [{}, { data: {} }, null, 42, []]) {
		assert.throws(() => parseKeyStatus(bad as never), (e: unknown) => e instanceof UsageError && e.code === "parse");
	}
});

test("parseCredits: live shape, negative balances allowed", () => {
	const a = parseCredits({ data: { total_credits: 5217.29, total_usage: 5067.59 } });
	assert.equal(a.totalCredits, 5217.29);
	assert.equal(a.balance, 149.69999999999982); // float math kept as-is; formatting rounds
	const neg = parseCredits({ data: { total_credits: 10, total_usage: 12.5 } });
	assert.equal(neg.balance, -2.5);
});

test("parseCredits: malformed shapes throw", () => {
	for (const bad of [{}, { data: {} }, { data: { total_credits: "x" } }, null]) {
		assert.throws(() => parseCredits(bad as never), (e: unknown) => e instanceof UsageError && e.code === "parse");
	}
});

test("parseLimitReset: cadences map; unknown strings pass through opaquely", () => {
	assert.equal(parseLimitReset("daily"), "daily");
	assert.equal(parseLimitReset("weekly"), "weekly");
	assert.equal(parseLimitReset("monthly"), "monthly");
	assert.equal(parseLimitReset(null), undefined);
	assert.equal(parseLimitReset("some_new_cadence"), "some_new_cadence");
});

test("fingerprintOf: HMAC of user id, stable, never equals raw id, label fallback", () => {
	const a = fingerprintOf("user_abc");
	assert.equal(a, fingerprintOf("user_abc"));
	assert.equal(a.length, 16);
	assert.match(a, /^[0-9a-f]{16}$/);
	assert.notEqual(a, "user_abc");
	assert.notEqual(fingerprintOf("user_abc"), fingerprintOf("user_abd"));
	// label fallback when user id missing / empty
	assert.equal(fingerprintOf("", "label-1"), fingerprintOf("", "label-1"));
	assert.notEqual(fingerprintOf("", "label-1"), fingerprintOf("", "label-2"));
});

test("salt prefix sanity", () => {
	assert.equal(SNAPSHOT_SALT_PREFIX, "pi-openrouter-balance\0");
});
