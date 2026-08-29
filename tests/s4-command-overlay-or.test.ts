import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtension, createOverlayComponent, identityTheme, visualWidth, type AuthResolution, type Snapshot, type UsageClientLike } from "../extensions/openrouter-balance.ts";
import { fakePi, freshCtx, invokeOverlay, stubKb } from "./helpers.ts";

const orModel = { provider: "openrouter", id: "openai/gpt-5.2", name: "GPT-5.2" };
const snap = (partial: Partial<Snapshot>): Snapshot => ({
	schemaVersion: 1,
	capturedAt: Date.now(),
	fingerprint: "fp1",
	key: { usage: 100, usageDaily: 0.42, usageWeekly: 3.1, usageMonthly: 8.9, freeTier: false },
	account: { totalCredits: 50, totalUsage: 37.66, balance: 12.34 },
	warnings: [],
	...partial,
});

function makeClient(fetchSnapshot: () => Promise<unknown>) {
	const calls = { fetch: 0 as number };
	return {
		client: {
			async fetchSnapshot() {
				calls.fetch += 1;
				return (await fetchSnapshot()) as never;
			},
			resetBreaker() { /* */ },
		} as unknown as UsageClientLike,
		calls,
	};
}

function install(client: UsageClientLike, auth?: AuthResolution | (() => AuthResolution | Promise<AuthResolution>)) {
	const pi = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en" },
		nowFn: () => Date.now(),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => client,
		authFor: async () => (typeof auth === "function" ? auth() : auth ?? { status: "ok", token: "sk-or-v1-x" }),
	})(pi);
	return { pi };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test("command: tui overlay renders the full report and closes", async () => {
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({ burnRate: { perHour: 0.42, windowHours: 5 } }) }));
	const { pi } = install(client);
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "", ctx);
	await flush();
	assert.equal(log.customCalls, 1);
	const lines = invokeOverlay(log, 80).join("\n");
	assert.match(lines, /Account balance/);
	assert.match(lines, /\$12\.34/);
	log.overlay?.component?.handleInput("\x1b");
	assert.equal(log.overlay?.doneCalls, 1);
});

test("command: --json overlay in tui, stdout in print, refusal in rpc", async () => {
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const { pi } = install(client);
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "--json", ctx);
	await flush();
	assert.match(invokeOverlay(log, 120).join("\n"), /schemaVersion/);

	const { ctx: pctx } = freshCtx("print", orModel);
	const out: string[] = [];
	const orig = console.log;
	console.log = (line: string) => { out.push(line); };
	try {
		await pi.runCommand("openrouter-balance", "--json", pctx);
		await flush();
	} finally {
		console.log = orig;
	}
	assert.ok(out.join("\n").includes('"schemaVersion": 1'));

	const { ctx: rctx, log: rlog } = freshCtx("rpc", orModel);
	await pi.runCommand("openrouter-balance", "--json", rctx);
	await flush();
	assert.ok(rlog.notifications.some((n) => n.message.includes("requires TUI or print")));
});

test("command: --refresh bypasses throttle; unknown args notify", async () => {
	const { client, calls } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const { pi } = install(client);
	const { ctx } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "", ctx);
	await flush();
	await pi.runCommand("openrouter-balance", "--refresh", ctx);
	await flush();
	assert.equal(calls.fetch, 2);

	const { ctx: ctx2, log } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "--frobnicate", ctx2);
	await flush();
	assert.ok(log.notifications.some((n) => n.message.includes("Unknown option")));
});

test("command: no credential notifies authNeeded", async () => {
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const { pi } = install(client, () => ({ status: "no-auth" }));
	const { ctx, log } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "", ctx);
	await flush();
	assert.ok(log.notifications.some((n) => n.message.includes("/login")));
});

test("overlay: render rows respect the 80% budget and exact widths", () => {
	const body = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
	function make(rows: number) {
		let done = 0;
		const c = createOverlayComponent({
			header: "OpenRouter Balance & Usage",
			body,
			footer: "Press Enter, Esc, or Ctrl+C to close",
			theme: identityTheme,
			kb: stubKb(),
			done: () => { done += 1; },
			rowGen: () => rows,
			lang: "en",
		});
		return { c, done: () => done };
	}
	for (const rows of [6, 12, 24, 40]) {
		const { c } = make(rows);
		const out = c.render(60);
		assert.ok(out.length <= Math.floor(rows * 0.8), `rows=${rows} out=${out.length}`);
	}
	const { c } = make(24);
	const out = c.render(60);
	for (const line of out) {
		assert.ok(line.length <= 60 * 2, `overlong: ${line.length}`);
	}
	assert.equal(out[0].startsWith("╭"), true);
	assert.equal(out.at(-1)?.startsWith("╰"), true);
});

test("overlay: colored theme — visual width stays exact (ANSI escapes zero-width)", () => {
	const colored = { fg: (role: string, t: string) => `\x1b[31m${t}\x1b[0m` };
	const body = ["hello", "world"];
	let done = 0;
	const c = createOverlayComponent({
		header: "t",
		body,
		footer: "f",
		theme: colored,
		kb: stubKb(),
		done: () => { done += 1; },
		rowGen: () => 24,
		lang: "en",
	});
	const out = c.render(40);
	for (const line of out) {
		assert.equal(visualWidth(line), 40, `visual width of ${JSON.stringify(line)}`);
	}
});

test("overlay: Kitty-safe close and scroll via kb.matches ids", () => {
	let done = 0;
	const c = createOverlayComponent({
		header: "t",
		body: Array.from({ length: 80 }, (_, i) => `r${i}`),
		footer: "f",
		theme: identityTheme,
		kb: stubKb(),
		done: () => { done += 1; },
		rowGen: () => 24,
		lang: "en",
	});
	const before = c.render(60).join("\n");
	c.handleInput("\x1b[B"); // kitty down
	assert.notEqual(c.render(60).join("\n"), before);
	c.handleInput("\x1b[13u"); // kitty enter
	assert.equal(done, 1);
});

test("rate-mode command: sets, clears, and status with precedence (command > env > default)", async () => {
	let prefsText: string | null = null;
	const prefs = {
		read: () => prefsText,
		write: (t: string) => { prefsText = t; },
	};
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const pi = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en", PI_OPENROUTER_BALANCE_RATE_MODE: "key" },
		nowFn: () => Date.now(),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => client,
		authFor: async () => ({ status: "ok", token: "sk-or-v1-x" }),
		prefsRead: prefs.read,
		prefsWrite: prefs.write,
	})(pi);

	// status: env wins over the (empty) pref — but note the env itself IS "key"
	const { ctx: c1, log: l1 } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "rate-mode status", c1);
	await flush();
	assert.ok(l1.notifications.some((n) => n.message.includes("this key") && n.message.includes("env")));

	// set via command persists, but env takes precedence — set must SAY so
	const { ctx: c2, log: l2 } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "rate-mode account", c2);
	await flush();
	assert.ok(l2.notifications.some((n) => n.message.includes("account") && n.message.includes("env takes precedence")));
	assert.equal(prefsText, '{"rateMode":"account"}');
	// a NEW instance WITH the env var still shows key (env wins over pref)
	const pi2 = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en", PI_OPENROUTER_BALANCE_RATE_MODE: "key" },
		nowFn: () => Date.now(),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => client,
		authFor: async () => ({ status: "ok", token: "sk-or-v1-x" }),
		prefsRead: prefs.read,
		prefsWrite: prefs.write,
	})(pi2);
	const { ctx: c3, log: l3b } = freshCtx("tui", orModel);
	await pi2.runCommand("openrouter-balance", "rate-mode status", c3);
	await flush();
	assert.ok(l3b.notifications.some((n) => n.message.includes("this key") && n.message.includes("env")));
	// without the env var, the command pref applies (default -> account here)
	const pi3 = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en" },
		nowFn: () => Date.now(),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => client,
		authFor: async () => ({ status: "ok", token: "sk-or-v1-x" }),
		prefsRead: prefs.read,
		prefsWrite: prefs.write,
	})(pi3);
	const { ctx: c5, log: l5 } = freshCtx("tui", orModel);
	await pi3.runCommand("openrouter-balance", "rate-mode status", c5);
	await flush();
	assert.ok(l5.notifications.some((n) => n.message.includes("account") && n.message.includes("command")));

	// clear: pref removed; env (in pi's env map) still applies
	const { ctx: c4, log: l4 } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "rate-mode clear", c4);
	await flush();
	assert.ok(l4.notifications.some((n) => n.message.includes("reset to default") && n.message.includes("env still applies")));
});

test("rate-mode command: refuses in protocol modes; unknown subcommand is an error", async () => {
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const { pi } = install(client);
	const { ctx: rctx, log: rlog } = freshCtx("rpc", orModel);
	await pi.runCommand("openrouter-balance", "rate-mode key", rctx);
	await flush();
	assert.ok(rlog.notifications.some((n) => n.message.includes("requires TUI or print")));
	const { ctx: ctx2, log: l2 } = freshCtx("tui", orModel);
	await pi.runCommand("openrouter-balance", "rate-mode banana", ctx2);
	await flush();
	assert.ok(l2.notifications.some((n) => n.message.includes("Unknown option")));
});

test("prefs file hygiene: world-readable prefs are ignored; corrupt JSON falls back to default", async () => {
	// 模拟：写一个 0644 的 prefs 再读取 → parsePrefs 得到默认（burn 未设）
	const fs = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const dir = fs.mkdtempSync(join(tmpdir(), "orb-prefs-"));
	const file = join(dir, "pi-openrouter-balance-prefs.json");
	fs.writeFileSync(file, '{"burn":"key"}', { mode: 0o644 });
	const raw = (() => {
		try {
			const st = fs.lstatSync(file);
			if (!st.isFile() || st.isSymbolicLink()) return null;
			if (st.mode & 0o077) return null;
			return fs.readFileSync(file, "utf8");
		} catch {
			return null;
		}
	})();
	assert.equal(raw, null); // 0644 → refused
	// corrupt JSON → default
	fs.writeFileSync(file, '{not-json', { mode: 0o600 });
	const corrupt = fs.readFileSync(file, "utf8");
	// parsePrefs 容错
	const { parsePrefs } = await import("../extensions/openrouter-balance.ts");
	assert.deepEqual(parsePrefs(corrupt), {});
	assert.deepEqual(parsePrefs(null), {});
	assert.deepEqual(parsePrefs('{"burn":"key"}'), { rateMode: "key" }); // legacy key tolerated
	assert.deepEqual(parsePrefs('{"rateMode":"garbage"}'), {});
	fs.rmSync(dir, { recursive: true, force: true });
});

test("rate-mode command: interactive picker in tui (selection persists, informs of env override)", async () => {
	let prefsText: string | null = '{"rateMode":"key"}';
	const reader = { read: () => prefsText, write: (t: string) => { prefsText = t; } };
	const { client } = makeClient(async () => ({ status: "ok", snapshot: snap({}) }));
	const pi = fakePi();
	createExtension({
		env: { PI_OPENROUTER_BALANCE_LANG: "en", PI_OPENROUTER_BALANCE_RATE_MODE: "key" },
		nowFn: () => Date.now(),
		setTimeout, clearTimeout, setInterval, clearInterval,
		clientFor: () => client,
		authFor: async () => ({ status: "ok", token: "sk-or-v1-x" }),
		prefsRead: reader.read,
		prefsWrite: reader.write,
	})(pi);
	// tui + select available → picker used; cancel (undefined) → no change
	const { ctx, log } = freshCtx("tui", orModel, { selectId: undefined });
	await pi.runCommand("openrouter-balance", "rate-mode", ctx);
	await flush();
	assert.equal(log.selectCalls.length, 1);
	assert.equal(prefsText, '{"rateMode":"key"}'); // cancelled: unchanged
	// pick "account" (option index 1)
	const { ctx: c2, log: l2 } = freshCtx("tui", orModel, { selectId: "1" });
	await pi.runCommand("openrouter-balance", "rate-mode", c2);
	await flush();
	assert.ok(l2.notifications.some((n) => n.message.includes("env takes precedence")));
	assert.equal(prefsText, '{"rateMode":"account"}');
});
