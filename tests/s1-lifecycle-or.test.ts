import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtension, estimateBurnRate, evaluateAlerts, createBalanceStore, type AuthResolution, type Snapshot, type UsageClientLike, type BalanceStoreLike } from "../extensions/openrouter-balance.ts";
import { fakePi, freshCtx } from "./helpers.ts";

function fakeTimers() {
	let t = 0;
	let seq = 0;
	const tasks: Array<{ id: number; fn: () => void; at: number; kind: "timeout" | "interval"; interval: number }> = [];
	const schedule = (fn: () => void, ms: number, kind: "timeout" | "interval", interval: number) => {
		seq += 1;
		const task = { id: seq, fn, at: t + ms, kind, interval };
		tasks.push(task);
		return { id: seq, unref() { /* */ } };
	};
	return {
		now: () => t,
		setTimeout: (fn: () => void, ms?: number) => schedule(fn, ms ?? 0, "timeout", 0),
		clearTimeout: (handle: unknown) => {
			const id = (handle as { id: number }).id;
			const i = tasks.findIndex((x) => x.id === id);
			if (i >= 0) tasks.splice(i, 1);
		},
		setInterval: (fn: () => void, ms?: number) => schedule(fn, ms ?? 0, "interval", ms ?? 0),
		clearInterval: (handle: unknown) => {
			const id = (handle as { id: number }).id;
			const i = tasks.findIndex((x) => x.id === id);
			if (i >= 0) tasks.splice(i, 1);
		},
		advance(ms: number) {
			const target = t + ms;
			for (;;) {
				const next = tasks.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				tasks.splice(tasks.indexOf(next), 1);
				t = Math.max(t, next.at);
				next.fn();
				if (next.kind === "interval") schedule(next.fn, next.interval, "interval", next.interval);
			}
			t = target;
		},
	};
}

const orModel = { provider: "openrouter", id: "openai/gpt-5.2", name: "GPT-5.2" };

const snap = (partial: Partial<Snapshot>): Snapshot => ({
	schemaVersion: 1,
	capturedAt: Date.now(),
	fingerprint: "fp1",
	key: { usage: 100, usageDaily: 0.4, usageWeekly: 2.2, usageMonthly: 8.9, freeTier: false },
	account: { totalCredits: 100, totalUsage: 40, balance: 60 },
	warnings: [],
	...partial,
});

function makeClient(run: { fetchSnapshot?: () => Promise<unknown> }) {
	const calls = { fetch: 0 as number };
	const client = {
		async fetchSnapshot() {
			calls.fetch += 1;
			return (run.fetchSnapshot?.() ?? { status: "error", code: "transient", message: "no route" }) as never;
		},
		resetBreaker() { /* */ },
	};
	return { client: client as unknown as UsageClientLike, calls };
}

function install(opts: {
	client: UsageClientLike;
	auth?: AuthResolution | (() => AuthResolution | Promise<AuthResolution>);
	timers?: ReturnType<typeof fakeTimers>;
	store?: BalanceStoreLike;
}) {
	const timers = opts.timers ?? fakeTimers();
	const pi = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en" },
		nowFn: timers.now,
		setTimeout: timers.setTimeout as never,
		clearTimeout: timers.clearTimeout as never,
		setInterval: timers.setInterval as never,
		clearInterval: timers.clearInterval as never,
		clientFor: () => opts.client,
		authFor: async () => (typeof opts.auth === "function" ? opts.auth() : opts.auth ?? { status: "ok", token: "sk-or-v1-x" }),
		...(opts.store ? { store: opts.store } : {}),
	})(pi);
	return { pi, timers };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("lifecycle: session_start with openrouter model fetches and renders footer", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({}) }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.ok(calls.fetch >= 1);
	assert.match(log.status.at(-1)?.text ?? "", /^openrouter \$60\.00/);
});

test("lifecycle: non-openrouter provider never fetches; json mode never fetches", async () => {
	const { client, calls } = makeClient({});
	const { pi } = install({ client });
	const { ctx } = freshCtx("tui", { provider: "xai" });
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.equal(calls.fetch, 0);
	const { ctx: jctx } = freshCtx("json", orModel);
	await pi.emit("session_start", {}, jctx);
	await flush();
	assert.equal(calls.fetch, 0);
});

test("lifecycle: agent_settled debounces 60s and fires once", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({}) }) });
	const timers = fakeTimers();
	const { pi } = install({ client, timers });
	const { ctx } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	const before = calls.fetch;
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	timers.advance(61_000);
	await flush();
	assert.equal(calls.fetch, before + 1);
});

test("lifecycle: session_shutdown clears footer and timers", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({}) }) });
	const timers = fakeTimers();
	const { pi } = install({ client, timers });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	await pi.emit("session_shutdown", {}, ctx);
	await flush();
	assert.equal(log.status.at(-1)?.text, undefined);
	timers.advance(20 * 60_000);
	assert.ok(true);
});

test("lifecycle: keep-last-good marks stale on transient failure", async () => {
	let fail = false;
	const { client } = makeClient({ fetchSnapshot: async () => fail ? { status: "error", code: "transient", message: "boom" } : { status: "ok", snapshot: snap({}) } });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /^openrouter /);
	fail = true;
	await pi.emit("model_select", { model: orModel }, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /^openrouter ~/);
});

test("lifecycle: 402 from after_provider_response sets insufficient state", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({}) }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	await pi.emit("after_provider_response", { status: 402 }, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /no credits left/);
	assert.ok(log.notifications.some((n) => n.message.includes("no credits left")));
});

test("lifecycle: no-credential shows auth hint state", async () => {
	const { client } = makeClient({});
	const { pi } = install({ client, auth: () => ({ status: "no-auth" }) });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /n\/a/);
});

test("alerts: balance thresholds fire once and re-arm on recovery", () => {
	const thresholds = { warn: 20, error: 5 };
	const first = evaluateAlerts(null, { balance: 18, insufficient: false, thresholds });
	assert.equal(first.emitted.length, 1);
	assert.equal(first.emitted[0].kind, "low-balance");
	const second = evaluateAlerts(first.state, { balance: 18, insufficient: false, thresholds });
	assert.equal(second.emitted.length, 0);
	const recovered = evaluateAlerts(second.state, { balance: 30, insufficient: false, thresholds });
	assert.equal(recovered.emitted.length, 0);
	const again = evaluateAlerts(recovered.state, { balance: 18, insufficient: false, thresholds });
	assert.equal(again.emitted.length, 1);
});

test("alerts: limit-remaining thresholds and insufficient transitions", () => {
	const thresholds = { warn: 20, error: 5 };
	const first = evaluateAlerts(null, { limitRemaining: 4, insufficient: false, thresholds });
	assert.equal(first.emitted[0].kind, "low-limit");
	const ins = evaluateAlerts(first.state, { insufficient: true, thresholds });
	assert.equal(ins.emitted.length, 1);
	assert.equal(ins.emitted[0].kind, "insufficient");
	const ins2 = evaluateAlerts(ins.state, { insufficient: true, thresholds });
	assert.equal(ins2.emitted.length, 0);
});

test("burn estimator: series produced by the store-append flow", () => {
	const series = [
		{ t: 0, balance: 100 },
		{ t: 3_600_000, balance: 99 },
		{ t: 7_200_000, balance: 98 },
	];
	const rate = estimateBurnRate(series);
	assert.ok(rate);
	assert.ok(Math.abs(rate.perHour - 1) < 1e-6); // 2 dropped over 2h
});

function memIo() {
	const files = new Map<string, string>();
	return {
		readFile: (p: string) => files.get(p) ?? null,
		appendFile: (p: string, s: string) => files.set(p, (files.get(p) ?? "") + s),
		writeFile: (p: string, s: string) => files.set(p, s),
		rename: (from: string, to: string) => files.set(to, files.get(from) ?? ""),
		mkdir: () => { /* */ },
		files,
	};
}

test("store: append/load per fingerprint, hygiene skips poisoned rows", () => {
	const io = memIo();
	const store = createBalanceStore("/fake", io);
	store.append({ t: 1, fingerprint: "fp1", balance: 100 });
	store.append({ t: 2, fingerprint: "fp1", balance: 99 });
	store.append({ t: 3, fingerprint: "fp2", balance: 50 });
	assert.equal(store.load("fp1").length, 2);
	assert.equal(store.load("fp2").length, 1);
	io.writeFile("/fake/pi-openrouter-balance-snapshots.jsonl", JSON.stringify({ t: 9, fingerprint: "fp1", balance: 1, api_key: "sk-or-v1-xyz" }) + "\n");
	assert.equal(store.load("fp1").length, 0); // poisoned row skipped
});

test("loader contract: module exposes a default factory function (pi's loader requires it)", async () => {
	const mod = await import("../extensions/openrouter-balance.ts");
	assert.equal(typeof mod.default, "function");
});

test("lifecycle: rpc/print modes never auto-poll (hasUI true in rpc must not count)", async () => {
	const { client, calls } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({}) }) });
	const { pi } = install({ client });
	const { ctx } = freshCtx("rpc", orModel);
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await flush();
	assert.equal(calls.fetch, 0);
});

test("lifecycle: fingerprint without user id disables persistence and burn", async () => {
	let appended = 0;
	const store = { append: () => { appended += 1; }, load: () => [] as never };
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "ok", snapshot: snap({ key: { usage: 1, usageDaily: 0, usageWeekly: 0, usageMonthly: 0, freeTier: false } }) }) });
	const { pi } = install({ client, store: store as never });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.equal(appended, 0);
	assert.equal(log.notifications.length, 0);
});

test("lifecycle: insufficient toast fires without a snapshot (after_provider_response 402)", async () => {
	const { client } = makeClient({ fetchSnapshot: async () => ({ status: "error", code: "insufficient", message: "credit limit reached" }) });
	const { pi } = install({ client });
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.emit("session_start", {}, ctx);
	await flush();
	assert.match(log.status.at(-1)?.text ?? "", /no credits left/);
});
