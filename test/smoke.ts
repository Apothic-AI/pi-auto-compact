/**
 * Mock smoke test for extensions/auto-compact.ts.
 *
 * Runs with plain Node (>=22.18 / >=23.6 native TS type stripping):
 *   npm test
 *
 * Mocks the ExtensionAPI surface (events, commands, ctx.ui, ctx.compact) and
 * covers: threshold math, soft-error fail-open, hard-fail fail-closed,
 * concurrent-prompt serialization, session-switch guarding, config
 * persistence/hot reload, the mid-run tool_call check, and Pi threshold
 * alignment. The real pi SDK is imported for
 * estimateTokens/getAgentDir; no agent state is touched because
 * PI_CODING_AGENT_DIR points at a throwaway temp dir set before the
 * extension module resolves CONFIG_FILE.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
} from "@earendil-works/pi-ai";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-compact-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// The suite owns this throwaway agent dir; leaving one per run behind fills %TEMP%.
after(() => rmSync(agentDir, { recursive: true, force: true }));
const CONFIG_FILE = join(agentDir, "pi-auto-compact.json");
const SETTINGS_FILE = join(agentDir, "settings.json");
/** deepseek-flash-shaped model: 1M window, so 78% leaves a 220k reserve. */
const MODEL = { provider: "deepseek", id: "deepseek-flash", contextWindow: 1_000_000 };
const GPT_MODEL = { provider: "subrouter-gpt", id: "gpt-6.2-sol", contextWindow: 1_050_000 };
const OTHER_GPT_MODEL = { provider: "relayfast", id: "gpt-6-sol", contextWindow: 1_050_000 };

const { default: createExtension } = await import(
	"../extensions/auto-compact.ts"
);

type Handler = (event: any, ctx: any) => any;

interface MockPi {
	pi: any;
	events: Map<string, Handler[]>;
	commands: Map<
		string,
		{
			description: string;
			getArgumentCompletions?: (prefix: string) => any;
			handler: Handler;
		}
	>;
}

function makePi(): MockPi {
	const events = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{
			description: string;
			getArgumentCompletions?: (prefix: string) => any;
			handler: Handler;
		}
	>();
	const pi = {
		on(name: string, handler: Handler) {
			if (!events.has(name)) events.set(name, []);
			events.get(name)!.push(handler);
		},
		registerCommand(
			name: string,
			def: {
				description: string;
				getArgumentCompletions?: (prefix: string) => any;
				handler: Handler;
			},
		) {
			commands.set(name, def);
		},
		// Pi serves the merged global+project settings from disk; the tests only
		// ever write the global one.
		getSettings(): Record<string, unknown> {
			try {
				return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
			} catch {
				return {};
			}
		},
	};
	return { pi, events, commands };
}

function install(pi: MockPi) {
	createExtension(pi.pi);
	return {
		fireInput: (event: any, ctx: any) =>
			pi.events.get("input")![0]!({ source: "interactive", ...event }, ctx),
		fireTurnEnd: async (ctx: any, event: any = {}) => {
			const results = [];
			for (const h of pi.events.get("turn_end")!) {
				results.push(await h(event, ctx));
			}
			return results;
		},
		fireSessionStart: (ctx: any) =>
			pi.events.get("session_start")!.map((h) => h({}, ctx)),
		fireSessionCompact: (ctx: any) =>
			pi.events
				.get("session_compact")!
				.map((h) => h({ compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false }, ctx)),
		fireToolCall: (ctx: any, toolName = "bash") =>
			pi.events.get("tool_call")!.map((h) => h({ toolName, input: {} }, ctx)),
		fireModelSelect: (ctx: any) =>
			pi.events
				.get("model_select")!
				.map((h) => h({ model: MODEL, previousModel: undefined, source: "set" }, ctx)),
		command: (name: string) => pi.commands.get(name)!,
	};
}

interface CompactHandler {
	onComplete?: (result: any) => void;
	onError?: (error: Error) => void;
}

interface CtxHarness {
	ctx: any;
	compacts: CompactHandler[];
	statuses: (string | undefined)[];
	notifies: { text: string; kind: string }[];
}

function makeAssistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: MODEL.provider,
		model: MODEL.id,
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function makeBoundaryContextEntries(entries: Array<{
	id: string;
	role: "user" | "assistant" | "toolResult";
	text: string;
	toolCallId?: string;
	toolName?: string;
}>) {
	return entries.map((item) => {
		const message =
			item.role === "user"
				? { role: "user", content: item.text, timestamp: Date.now() }
				: item.role === "assistant"
					? {
							...makeAssistantResponse(item.text),
							content: item.toolCallId
								? [
										{ type: "text", text: item.text },
										{ type: "toolCall", id: item.toolCallId, name: item.toolName ?? "bash", arguments: {} },
									]
								: [{ type: "text", text: item.text }],
						}
					: {
							role: "toolResult",
							toolCallId: item.toolCallId ?? "call-1",
							toolName: item.toolName ?? "bash",
							content: [{ type: "text", text: item.text }],
							isError: false,
							timestamp: Date.now(),
						};
		return {
			sourceEntry: {
				type: "message",
				id: item.id,
				parentId: null,
				timestamp: new Date().toISOString(),
				message,
			},
			messages: [message],
		};
	});
}

function makeCtx(opts: {
	usage?: { tokens: number | null; contextWindow: number };
	onCompact?: (handlers: CompactHandler) => void;
	model?: { provider: string; id: string; contextWindow: number } | undefined;
	streamSimple?: (...args: any[]) => any;
	signal?: AbortSignal;
	thinkingLevel?: string;
}): CtxHarness {
	const compacts: CompactHandler[] = [];
	const harness: CtxHarness = {
		ctx: {
			hasUI: true,
			model: "model" in opts ? opts.model : MODEL,
			signal: opts.signal,
			thinkingLevel: opts.thinkingLevel ?? "off",
			modelRegistry: opts.streamSimple
				? { streamSimple: opts.streamSimple }
				: undefined,
			getContextUsage: () => opts.usage,
			compact(handlers: CompactHandler) {
				compacts.push(handlers);
				opts.onCompact?.(handlers);
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					harness.statuses.push(text);
				},
				notify: (text: string, kind: string) => {
					harness.notifies.push({ text, kind });
				},
				theme: { fg: (_kind: string, text: string) => text },
			},
		},
		compacts,
		statuses: [],
		notifies: [],
	};
	return harness;
}

function writeConfig(value: Record<string, unknown>) {
	writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2), "utf8");
}

function writePiSettings(value: Record<string, unknown>) {
	writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), "utf8");
}

function readPiSettings(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		return {};
	}
}

// --- baseline gating ---------------------------------------------------------

test("below threshold: prompt flows through without compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 0);
});

test("unknown usage or queued steer/followUp: preflight skipped", async () => {
	const pi = install(makePi());
	const noUsage = makeCtx({ usage: undefined });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, noUsage.ctx)).action,
		"continue",
	);
	assert.equal(noUsage.compacts.length, 0);

	const nullTokens = makeCtx({ usage: { tokens: null, contextWindow: 100 } });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, nullTokens.ctx)).action,
		"continue",
	);

	const queued = makeCtx({ usage: { tokens: 99, contextWindow: 100 } });
	const res = await pi.fireInput(
		{ text: "hi", streamingBehavior: "steer" },
		queued.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(queued.compacts.length, 0);
});

test("projected over threshold: compact once, then send", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput({ text: "a long prompt goes here" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 1);
	assert.match(h.statuses[0]!, /projected/);
	assert.equal(h.statuses.at(-1), undefined, "status cleared after success");
});

test("image prompts project image cost into usage (text alone stays below)", async () => {
	const pi = install(makePi());
	const textOnly = makeCtx({ usage: { tokens: 76, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, textOnly.ctx);
	assert.equal(
		textOnly.compacts.length,
		0,
		"76 + ~1 token stays under the 78% line",
	);

	const withImage = makeCtx({
		usage: { tokens: 76, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput(
		{
			text: "hi",
			images: [{ type: "image", data: "Zm9v", mimeType: "image/png" }],
		},
		withImage.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(
		withImage.compacts.length,
		1,
		"image adds 4800 chars, pushing projection past the line",
	);
});

// --- failure classification --------------------------------------------------

test("soft errors fail open without an error status", async () => {
	for (const message of [
		"Nothing to compact (session too small)",
		"Already compacted",
	]) {
		const pi = install(makePi());
		const h = makeCtx({
			usage: { tokens: 90, contextWindow: 100 },
			onCompact: (c) => c.onError?.(new Error(message)),
		});
		const res = await pi.fireInput({ text: "hi" }, h.ctx);
		assert.equal(res.action, "continue", message);
		assert.equal(h.notifies.at(-1)?.kind, "warning", message);
		assert.match(h.notifies.at(-1)!.text, /Sending prompt anyway/, message);
		assert.ok(!h.statuses.includes("compact failed"), message);
	}
});

test("aborted compaction is fail-closed: prompt not sent", async () => {
	const pi = install(makePi());
	const error = new Error("Compaction cancelled");
	error.name = "AbortError";
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(error),
	});
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent/);
	assert.ok(h.statuses.includes("compact failed"));
});

test("hard error: prompt not sent", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(new Error("provider exploded")),
	});
	const res = await pi.fireInput({ text: "important long prompt" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent — resubmit when ready/);
});

// --- concurrency / session guarding -------------------------------------------

test("two prompts racing past the guard share one compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: () => undefined,
	});
	const p1 = pi.fireInput({ text: "first" }, h.ctx);
	const p2 = pi.fireInput({ text: "second" }, h.ctx);
	h.compacts[0]!.onComplete?.({});
	assert.equal((await p1).action, "continue");
	assert.equal((await p2).action, "continue");
	assert.equal(h.compacts.length, 1);
});

test("session switch mid-compaction: stale callbacks never touch UI", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: () => undefined,
	});
	const pending = pi.fireInput({ text: "hi" }, h.ctx);
	pi.fireSessionStart(makeCtx({ usage: undefined }).ctx); // bumps generation
	h.compacts[0]!.onComplete?.({});
	assert.equal((await pending).action, "continue");
	assert.equal(
		h.statuses.length,
		1,
		"only the pre-compaction status was written",
	);
	assert.equal(h.notifies.length, 0);
});

// --- configuration -------------------------------------------------------------

test("turn_end status reflects the threshold and clears below it", async () => {
	writeConfig({ threshold: 50 });
	try {
		const pi = install(makePi());
		const hot = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
		await pi.fireTurnEnd(hot.ctx);
		assert.match(hot.statuses.at(-1)!, /compact before next prompt/);
		const cool = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
		await pi.fireTurnEnd(cool.ctx);
		assert.equal(cool.statuses.at(-1), undefined);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("threshold hot-reloads from disk between prompts", async () => {
	writeConfig({ threshold: 95 });
	const pi = install(makePi());
	const calm = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, calm.ctx);
	assert.equal(calm.compacts.length, 0, "90% < 95% threshold");

	writeConfig({ threshold: 50 });
	const hot = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	await pi.fireInput({ text: "hi" }, hot.ctx);
	assert.equal(hot.compacts.length, 1, "90% >= 50% after hot reload");

	// Out-of-range hand edits must fall back to the last valid value (92), not the tampered one.
	writeConfig({ threshold: 92 });
	const above92 = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, above92.ctx);
	assert.equal(above92.compacts.length, 0, "90% < 92%");

	writeConfig({ threshold: 25 }); // below MIN_THRESHOLD: reject, keep 92
	const tampered = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, tampered.ctx);
	assert.equal(tampered.compacts.length, 0, "tampered 25% must not take effect");
});

test("/compact-threshold persists atomically, merges keys, validates input", async () => {
	writeConfig({ threshold: 78, compactTimeoutMs: 5000 });
	const pi = install(makePi());
	const cmd = pi.command("compact-threshold");
	const h = makeCtx({ usage: undefined });

	await cmd.handler("", h.ctx);
	assert.match(h.notifies.at(-1)!.text, /^Auto-compaction threshold: 78%/);

	await cmd.handler("62", h.ctx);
	const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	assert.equal(saved.threshold, 62);
	assert.equal(
		saved.compactTimeoutMs,
		5000,
		"unknown config keys survive a save",
	);

	for (const bad of ["0", "20", "abc", "99", "100", "-5"]) {
		const before = readFileSync(CONFIG_FILE, "utf8");
		await cmd.handler(bad, h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning", bad);
		assert.equal(
			readFileSync(CONFIG_FILE, "utf8"),
			before,
			`${bad} must not touch the file`,
		);
	}

	await cmd.handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "reset removes the config file");
});

// --- mid-run (tool_call) check ------------------------------------------------

test("tool_call below threshold stays silent and never compacts", () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
	pi.fireToolCall(h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.compacts.length, 0, "a tool call must never trigger ctx.compact()");
});

test("tool_call above threshold reports mid-run compaction after the batch", () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 800_000, contextWindow: 1_000_000 } });
	pi.fireToolCall(h.ctx, "read");
	assert.match(h.statuses.at(-1)!, /context 80% . compacting after this tool batch/);
	assert.equal(h.compacts.length, 0, "ctx.compact() aborts the run; never called here");
	// Repeated identical checks must not re-write the status line.
	const before = h.statuses.length;
	pi.fireToolCall(h.ctx, "read");
	assert.equal(h.statuses.length, before, "status writes are deduplicated");
});

test("tool_call clears stale status when usage becomes unknown and hot-reloads config", () => {
	writeConfig({ threshold: 50 });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: { tokens: 60, contextWindow: 100 } });
		pi.fireToolCall(h.ctx);
		assert.match(h.statuses.at(-1)!, /context 60% . compacting after this tool batch/);

		const unknown = makeCtx({ usage: { tokens: null, contextWindow: 100 } });
		pi.fireToolCall(unknown.ctx);
		assert.equal(unknown.statuses.at(-1), undefined);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("tool_call without a model still reports mid-run compaction pressure", () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		model: undefined,
	});
	pi.fireToolCall(h.ctx);
	assert.match(h.statuses.at(-1)!, /context 90% . compacting after this tool batch/);
});

// --- pi threshold alignment ----------------------------------------------------

test("configured pattern applies to matching providers, exact key overrides it, and unmatched models use global fallback", async () => {
	writeConfig({ threshold: 78, modelThresholds: { "*/gpt-*": 40, "subrouter-gpt/gpt-6.2-sol": 47.62, "relayfast/gpt-6-sol*": 45 } });
	try {
		const pi = install(makePi());
		const command = makeCtx({ model: MODEL, usage: undefined });
		await pi.command("compact-threshold").handler("model */claude-* 55", command.ctx);
		assert.equal(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).modelThresholds["*/claude-*"], 55, "command writes arbitrary configured pattern");
		writeConfig({ threshold: 78, modelThresholds: { "*/gpt-*": 40, "subrouter-gpt/gpt-6.2-sol": 47.62, "relayfast/gpt-6-sol*": 45 } });
		const exact = makeCtx({ model: GPT_MODEL, usage: { tokens: 450_000, contextWindow: 1_050_000 } });
		pi.fireToolCall(exact.ctx);
		assert.equal(exact.statuses.at(-1), undefined, "exact 47.62 value wins over the matching 40% wildcard");

		const pattern = makeCtx({ model: OTHER_GPT_MODEL, usage: { tokens: 480_000, contextWindow: 1_050_000 } });
		pi.fireToolCall(pattern.ctx);
		assert.match(pattern.statuses.at(-1)!, /compacting after this tool batch/, "most-specific configured wildcard wins");

		const unmatched = makeCtx({ model: MODEL, usage: { tokens: 450_000, contextWindow: 1_000_000 } });
		pi.fireToolCall(unmatched.ctx);
		assert.equal(unmatched.statuses.at(-1), undefined, "unmatched model uses 78% global fallback");
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("align on writes a per-model reserve so pi compacts mid-run at our threshold", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ theme: "dark", compaction: { enabled: true } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align on", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /follows 78%/);
		assert.match(h.notifies.at(-1)!.text, /run \/reload to apply/);

		const settings = readPiSettings();
		assert.deepEqual(settings.compaction, {
			enabled: true,
			modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 220_000 } },
		});
		assert.equal(settings.theme, "dark", "unrelated settings survive");

		// pi now compacts at contextWindow - reserveTokens = 78%.
		const ctx = makeCtx({ usage: { tokens: 800_000, contextWindow: 1_000_000 } });
		pi.fireToolCall(ctx.ctx);
		assert.match(ctx.statuses.at(-1)!, /context 80% . compacting after this tool batch/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("a model switch re-aligns the new model", () => {
	writeConfig({ threshold: 78, alignPiThreshold: true });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		pi.fireModelSelect(h.ctx);
		assert.equal(
			readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"]
				.reserveTokens,
			220_000,
		);
		assert.match(h.notifies.at(-1)!.text, /aligned to 78%.*run \/reload to apply/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("exact model percentage overrides configured wildcard and preserves a user-owned reserve", async () => {
	writeConfig({ threshold: 78, modelThresholds: { "*/gpt-*": 40, "subrouter-gpt/gpt-6.2-sol": 47.62 }, alignPiThreshold: true });
	writePiSettings({ compaction: { modelOverrides: { "subrouter-gpt/gpt-6.2-sol": { reserveTokens: 550_000 } } } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ model: GPT_MODEL, usage: undefined });
		await pi.command("compact-threshold").handler("", h.ctx);
		const report = h.notifies.find((item) => item.text.includes("Auto-compaction threshold: 47.62% for subrouter-gpt/gpt-6.2-sol"))?.text;
		assert.ok(report, "status report uses exact model threshold");
		assert.match(report, /Global fallback: 78%/);
		assert.equal(readPiSettings().compaction.modelOverrides["subrouter-gpt/gpt-6.2-sol"].reserveTokens, 550_000,
			"explicit 500k-policy reserve remains user-owned and untouched");

		const gptBelowExact = makeCtx({ model: GPT_MODEL, usage: { tokens: 450_000, contextWindow: 1_050_000 } });
		pi.fireToolCall(gptBelowExact.ctx);
		assert.equal(gptBelowExact.statuses.at(-1), undefined, "exact 47.62% threshold overrides configured 40% wildcard");
		const gptAboveExact = makeCtx({ model: GPT_MODEL, usage: { tokens: 501_000, contextWindow: 1_050_000 } });
		pi.fireToolCall(gptAboveExact.ctx);
		assert.match(gptAboveExact.statuses.at(-1)!, /context 48% · compacting after this tool batch/);

		const deepseek = makeCtx({ model: MODEL, usage: { tokens: 450_000, contextWindow: 1_000_000 } });
		pi.fireToolCall(deepseek.ctx);
		assert.equal(deepseek.statuses.at(-1), undefined, "non-GPT model retains global 78% fallback");
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("align computes reserve from configured model pattern when no user reserve exists", async () => {
	writeConfig({ threshold: 78, modelThresholds: { "*/gpt-*": 40 }, alignPiThreshold: true });
	writePiSettings({ compaction: { enabled: true } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ model: GPT_MODEL, usage: undefined });
		pi.fireSessionStart(h.ctx);
		assert.equal(readPiSettings().compaction.modelOverrides["subrouter-gpt/gpt-6.2-sol"].reserveTokens, 630_000,
			"configured 40% of 1,050,000 leaves a 630,000-token reserve");
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("align on never overwrites a reserve the user configured", async () => {
	writeConfig({ threshold: 78, alignPiThreshold: true });
	writePiSettings({ compaction: { reserveTokens: 400_000 } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align on", h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning");
		assert.match(h.notifies.at(-1)!.text, /already has a compaction budget/);
		assert.equal(
			readPiSettings().compaction.reserveTokens,
			400_000,
			"the user's global reserve is untouched",
		);
		assert.ok(
			!readPiSettings().compaction.modelOverrides,
			"no per-model override is written either",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("align off removes only the reserve this extension wrote", async () => {
	writeConfig({
		threshold: 78,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 220_000 },
	});
	writePiSettings({
		compaction: {
			keepRecentTokens: 20_000,
			modelOverrides: {
				"deepseek/deepseek-flash": { reserveTokens: 220_000 },
				"xai/grok-4.7": { reserveTokens: 5_000 },
			},
		},
	});
	try {
		const pi = install(makePi());
		pi.fireSessionStart(makeCtx({ usage: undefined }).ctx);

		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align off", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /back to its own threshold/);
		const compaction = readPiSettings().compaction;
		assert.deepEqual(compaction.keepRecentTokens, 20_000);
		assert.deepEqual(compaction.modelOverrides, {
			"xai/grok-4.7": { reserveTokens: 5_000 },
		});
		assert.equal(
			JSON.parse(readFileSync(CONFIG_FILE, "utf8")).alignedReserveTokens?.["deepseek/deepseek-flash"],
			undefined,
			"the bookkeeping entry is dropped too",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("a reserve the user changed stops being managed", async () => {
	writeConfig({
		threshold: 78,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 220_000 },
	});
	writePiSettings({
		compaction: { modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 300_000 } } },
	});
	try {
		const pi = install(makePi());
		pi.fireSessionStart(makeCtx({ usage: undefined }).ctx);
		assert.equal(
			readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens,
			300_000,
			"the user's value wins",
		);
		assert.deepEqual(
			JSON.parse(readFileSync(CONFIG_FILE, "utf8")).alignedReserveTokens,
			{},
			"and it is no longer ours to remove",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("reset clears the threshold and the managed reserve", async () => {
	writeConfig({
		threshold: 40,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 600_000 },
	});
	writePiSettings({ compaction: { modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 600_000 } } } });
	const pi = install(makePi());
	const h = makeCtx({ usage: undefined });
	pi.fireSessionStart(h.ctx);
	assert.equal(
		readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens,
		600_000,
	);
	await pi.command("compact-threshold").handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "config file removed");
	assert.equal(readPiSettings().compaction, undefined, "pi's compaction block is cleaned up");
	rmSync(SETTINGS_FILE, { force: true });
});

test("/compact-threshold hot-reloads the config written by another session", async () => {
	writeConfig({ threshold: 78 });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi()); // loads 78%
		writeConfig({ threshold: 50, alignPiThreshold: true }); // another session changed it
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("", h.ctx);
		const text = h.notifies.at(-1)!.text;
		assert.match(text, /Auto-compaction threshold: 50%/);
		assert.match(text, /Pi threshold alignment: on/);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("/compact-threshold without arguments reports both thresholds", async () => {
	writeConfig({ threshold: 78 });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("", h.ctx);
		const text = h.notifies.at(-1)!.text;
		assert.match(text, /Auto-compaction threshold: 78% for deepseek\/deepseek-flash \(before prompts & after tool batches\)/);
		assert.match(text, /Pi built-in compaction triggers at 98% \(reserveTokens 16384, pi default\)/);

		await pi.command("compact-threshold").handler("align", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /Usage: \/compact-threshold align on\|off/);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

// --- mid-run turn_end compaction & review fixes ------------------------------

test("turn_end with toolResults compacts via CompactionEntryDraft without continue: true", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 } });
	try {
		const pi = install(makePi());
		let summaryCalls = 0;
		const h = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple: () => {
				summaryCalls++;
				const stream = createAssistantMessageEventStream();
				const msg = makeAssistantResponse("Compacted summary");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
				return stream;
			},
		});
		const contextEntries = makeBoundaryContextEntries([
			{ id: "e1", role: "user", text: "old prompt " + "a".repeat(20_000) },
			{ id: "e2", role: "assistant", text: "old answer" },
			{ id: "e3", role: "user", text: "keep turn " + "b".repeat(4_000) },
			{ id: "e4", role: "assistant", text: "calling tool", toolCallId: "c1" },
			{ id: "e5", role: "toolResult", text: "tool output", toolCallId: "c1" },
		]);
		const priorDraft = { type: "custom", customType: "note", data: { keep: true } };
		const [result] = await pi.fireTurnEnd(h.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [priorDraft],
			continue: false,
			context: { contextEntries, pendingMessages: [] },
		});
		assert.equal(summaryCalls, 1);
		assert.equal(result.continue, undefined, "must not force continue: true");
		assert.equal(result.entries.length, 2);
		assert.deepEqual(result.entries[0], priorDraft);
		assert.equal(result.entries[1].type, "compaction");
		assert.equal(result.entries[1].summary, "Compacted summary");
		assert.equal(result.entries[1].firstKeptEntryId, "e3");
		assert.equal(h.statuses.at(-1), undefined, "clears status on success");
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("turn_end skips mid-run compaction when nothing earlier, aborted, or already compacting", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 } });
	try {
		const pi = install(makePi());
		let summaryCalls = 0;
		const streamSimple = () => {
			summaryCalls++;
			const stream = createAssistantMessageEventStream();
			const msg = makeAssistantResponse("Unused");
			stream.push({ type: "start", partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
			return stream;
		};

		// Single turn within keepRecentTokens: nothing earlier to summarize.
		const single = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple,
		});
		const singleEntries = makeBoundaryContextEntries([
			{ id: "e1", role: "user", text: "short" },
			{ id: "e2", role: "assistant", text: "tool", toolCallId: "c1" },
			{ id: "e3", role: "toolResult", text: "ok", toolCallId: "c1" },
		]);
		const [singleRes] = await pi.fireTurnEnd(single.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [],
			context: { contextEntries: singleEntries, pendingMessages: [] },
		});
		assert.equal(singleRes, undefined);
		assert.match(single.statuses.at(-1)!, /nothing earlier to compact yet/);

		// Non-completed outcome skips mid-run compaction.
		const aborted = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple,
		});
		const [abortedRes] = await pi.fireTurnEnd(aborted.ctx, {
			outcome: "aborted",
			toolResults: [{ role: "toolResult" }],
			entries: [],
			context: { contextEntries: singleEntries, pendingMessages: [] },
		});
		assert.equal(abortedRes, undefined);
		assert.equal(aborted.statuses.at(-1), "compact before next prompt");

		// Prior compaction draft from another extension skips duplicate compaction.
		const dup = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple,
		});
		const [dupRes] = await pi.fireTurnEnd(dup.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [{ type: "compaction", summary: "other", firstKeptEntryId: "e2" }],
			context: { contextEntries: singleEntries, pendingMessages: [] },
		});
		assert.equal(dupRes, undefined);
		assert.equal(summaryCalls, 0);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("turn_end failure falls back gracefully without aborting the run", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 }, retry: { enabled: false } });
	try {
		const pi = install(makePi());
		const h = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple: () => {
				throw new Error("summary backend down");
			},
		});
		const contextEntries = makeBoundaryContextEntries([
			{ id: "e1", role: "user", text: "old prompt " + "a".repeat(20_000) },
			{ id: "e2", role: "assistant", text: "calling tool", toolCallId: "c1" },
			{ id: "e3", role: "toolResult", text: "b".repeat(8_000), toolCallId: "c1" },
		]);
		const [res] = await pi.fireTurnEnd(h.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [],
			context: { contextEntries, pendingMessages: [] },
		});
		assert.equal(res, undefined);
		assert.equal(h.statuses.at(-1), "mid-run compact failed");
		assert.equal(h.notifies.at(-1)?.kind, "warning");
		assert.match(h.notifies.at(-1)!.text, /Continuing without compaction/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("session_compact clears stale compact-before-next-prompt status", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireTurnEnd(h.ctx);
	assert.equal(h.statuses.at(-1), "compact before next prompt");
	pi.fireSessionCompact(h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
});

test("align off removes only reserveTokens and keeps user keepRecentTokens", async () => {
	writeConfig({
		threshold: 78,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 220_000 },
	});
	writePiSettings({
		compaction: {
			modelOverrides: {
				"deepseek/deepseek-flash": {
					reserveTokens: 220_000,
					keepRecentTokens: 32_000,
				},
			},
		},
	});
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align off", h.ctx);
		assert.deepEqual(readPiSettings().compaction, {
			modelOverrides: {
				"deepseek/deepseek-flash": { keepRecentTokens: 32_000 },
			},
		});
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("reset reminds to /reload only when settings.json changed", async () => {
	writeConfig({
		threshold: 40,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 600_000 },
	});
	writePiSettings({
		compaction: { modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 600_000 } } },
	});
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("reset", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /run \/reload to apply Pi settings/);

		await pi.command("compact-threshold").handler("reset", h.ctx);
		assert.doesNotMatch(h.notifies.at(-1)!.text, /\/reload/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("describePiTrigger handles disabled compaction and virtual models", async () => {
	writePiSettings({ compaction: { enabled: false } });
	try {
		const pi = install(makePi());
		const disabled = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("", disabled.ctx);
		assert.match(disabled.notifies.at(-1)!.text, /Pi built-in auto-compaction: disabled/);

		writePiSettings({ compaction: { enabled: true } });
		const virtual = makeCtx({
			model: { provider: "router", id: "auto", contextWindow: 0 },
			usage: { tokens: 50_000, contextWindow: 200_000 },
		});
		await pi.command("compact-threshold").handler("", virtual.ctx);
		assert.match(
			virtual.notifies.at(-1)!.text,
			/Pi built-in compaction triggers at 92% \(reserveTokens 16384, pi default\)/,
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("/compact-threshold getArgumentCompletions filters subcommands", () => {
	const pi = install(makePi());
	const cmd = pi.command("compact-threshold");
	assert.equal(cmd.getArgumentCompletions!("").length, 4);
	assert.deepEqual(
		cmd.getArgumentCompletions!("al").map((c: any) => c.value),
		["align on", "align off"],
	);
	assert.deepEqual(
		cmd.getArgumentCompletions!("align ").map((c: any) => c.value),
		["align on", "align off"],
	);
	assert.deepEqual(
		cmd.getArgumentCompletions!("re").map((c: any) => c.value),
		["reset"],
	);
	assert.equal(cmd.getArgumentCompletions!("unknown"), null);
});

test("turn_end ignores stale ctx.signal getter after session switch during compaction", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 } });
	try {
		const pi = install(makePi());
		let stale = false;
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		let finishStream!: () => void;
		const h = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const msg = makeAssistantResponse("Stale summary");
				stream.push({ type: "start", partial: msg });
				finishStream = () => stream.push({ type: "done", reason: "stop", message: msg });
				resolveStarted();
				return stream;
			},
		});
		Object.defineProperty(h.ctx, "signal", {
			get() {
				if (stale) throw new Error("This extension ctx is stale after session replacement");
				return undefined;
			},
		});
		const contextEntries = makeBoundaryContextEntries([
			{ id: "e1", role: "user", text: "old " + "a".repeat(20_000) },
			{ id: "e2", role: "user", text: "keep " + "b".repeat(5_000) },
			{ id: "e3", role: "assistant", text: "call", toolCallId: "c1" },
			{ id: "e4", role: "toolResult", text: "out", toolCallId: "c1" },
		]);
		const pending = pi.fireTurnEnd(h.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [],
			context: { contextEntries, pendingMessages: [] },
		});
		await started;
		stale = true;
		pi.fireSessionStart(makeCtx({ usage: undefined }).ctx);
		finishStream();
		const [res] = await pending;
		assert.equal(res, undefined);
		assert.equal(h.notifies.length, 0);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("turn_end skips ephemeral preview draft IDs from earlier extensions when picking firstKeptEntryId", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 } });
	try {
		const pi = install(makePi());
		const h = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const msg = makeAssistantResponse("Summary without preview id");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
				return stream;
			},
		});
		const persistedIds = new Set(["e1", "e2", "e3"]);
		h.ctx.sessionManager = {
			getEntry: (id: string) => (persistedIds.has(id) ? { id } : undefined),
		};
		const contextEntries = makeBoundaryContextEntries([
			{ id: "e1", role: "user", text: "old " + "a".repeat(20_000) },
			{ id: "e2", role: "assistant", text: "call", toolCallId: "c1" },
			{ id: "e3", role: "toolResult", text: "ok", toolCallId: "c1" },
			{ id: "preview-draft-id", role: "user", text: "ephemeral draft " + "d".repeat(8_000) },
		]);
		const [res] = await pi.fireTurnEnd(h.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [{ type: "custom_message", customType: "other", content: "ephemeral", display: false }],
			context: { contextEntries, pendingMessages: [] },
		});
		assert.equal(res.entries[1].type, "compaction");
		assert.equal(res.entries[1].firstKeptEntryId, "e2");
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("turn_end preserves cumulative readFiles and modifiedFiles across fromHook compactions", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ compaction: { keepRecentTokens: 1_000 } });
	try {
		const pi = install(makePi());
		const h = makeCtx({
			usage: { tokens: 800_000, contextWindow: 1_000_000 },
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const msg = makeAssistantResponse("Second compaction summary");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
				return stream;
			},
		});
		const prevCompaction = {
			type: "compaction",
			id: "cmp-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "First summary",
			firstKeptEntryId: "cmp-1",
			tokensBefore: 100_000,
			fromHook: true,
			details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
		};
		const contextEntries = [
			{
				sourceEntry: prevCompaction,
				messages: [{ role: "compactionSummary", summary: "First summary", tokensBefore: 100_000, timestamp: Date.now() }],
			},
			...makeBoundaryContextEntries([
				{ id: "e1", role: "user", text: "turn 1 " + "a".repeat(20_000) },
				{ id: "e2", role: "user", text: "turn 2 " + "b".repeat(5_000) },
				{ id: "e3", role: "assistant", text: "call", toolCallId: "c1" },
				{ id: "e4", role: "toolResult", text: "ok", toolCallId: "c1" },
			]),
		];
		const [res] = await pi.fireTurnEnd(h.ctx, {
			outcome: "completed",
			toolResults: [{ role: "toolResult" }],
			entries: [],
			context: { contextEntries, pendingMessages: [] },
		});
		assert.deepEqual(res.entries[0].details, {
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
		});
		assert.match(res.entries[0].summary, /<read-files>\na\.ts\n<\/read-files>/);
		assert.match(res.entries[0].summary, /<modified-files>\nb\.ts\n<\/modified-files>/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});
