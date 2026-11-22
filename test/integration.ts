/**
 * Real Pi SDK scheduling tests. Only model responses and summary generation are
 * replaced: tool execution, threshold checks, compaction persistence, context
 * rebuilding, and continuation all run through Pi. No network or user state.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DEFAULT_COMPACTION_SETTINGS,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-integration-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(root, { recursive: true, force: true }));
const { default: createExtension } = await import("../extensions/auto-compact.ts");
const CONFIG_FILE = join(agentDir, "pi-auto-compact.json");
const SETTINGS_FILE = join(agentDir, "settings.json");
const SUMMARY = "Goal: run grow then finish. Grow completed; next execute finish.";
const HISTORY_MARKER = "OLD_HISTORY_MARKER";
const CONTEXT_WINDOW = 200_000;

type Mode = "below-threshold" | "midrun" | "batch" | "preflight";

async function runScenario(mode: Mode, threshold = 78) {
	const cwd = mkdtempSync(join(root, "workspace-"));
	writeFileSync(CONFIG_FILE, JSON.stringify({ threshold }));
	writeFileSync(
		SETTINGS_FILE,
		JSON.stringify({
			compaction: { enabled: true, keepRecentTokens: 1000 },
			retry: { enabled: false },
		}),
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	// In-memory credential; all requests use the stream substitutes below.
	await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
	const baseModel = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(baseModel, "fixture model is in Pi's static catalog");
	const model = { ...baseModel, contextWindow: CONTEXT_WINDOW };
	const trace: string[] = [];
	let summaryCount = 0;
	const requests: { summary: boolean; history: boolean; toolOutput: boolean }[] = [];

	function response(
		content: AssistantMessage["content"],
		tokens: number,
		toolUse: boolean,
	): AssistantMessage {
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content,
			stopReason: toolUse ? "toolUse" : "stop",
			usage: {
				input: tokens,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens + 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function streamSummary(label: string) {
		summaryCount++;
		trace.push(label);
		const message = response([{ type: "text", text: SUMMARY }], 500, false);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	}

	// Extension turn_end mid-run compaction calls ctx.modelRegistry.streamSimple -> modelRuntime.streamSimple.
	modelRuntime.streamSimple = (() => streamSummary("midrun-compact")) as typeof modelRuntime.streamSimple;

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Run grow then finish, then say DONE.",
		extensionFactories: [
			createExtension,
			(pi) => {
				for (const name of ["grow", "finish"]) {
					pi.registerTool({
						name,
						label: name,
						description: `Execute ${name}`,
						parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
						execute: async () => {
							trace.push(`tool:${name}`);
							return {
								content: [
									{
										type: "text",
										text: name === "grow" ? "x".repeat(350_000) : "finished",
									},
								],
								details: undefined,
							};
						},
					});
				}
				pi.on("session_before_compact", (event) => {
					trace.push(`pi-before-compact:${event.reason}`);
				});
			},
		],
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(cwd);
	if (mode === "preflight") {
		// Pre-populate >78% usage across two turns so keepRecentTokens (1000) summarizes turn 1.
		sessionManager.appendMessage({
			role: "user",
			content: HISTORY_MARKER + "h".repeat(300_000),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(
			response([{ type: "text", text: "First task completed." }], 76_000, false),
		);
		sessionManager.appendMessage({
			role: "user",
			content: "recent turn context " + "r".repeat(6_000),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(
			response([{ type: "text", text: "Second task completed." }], 160_000, false),
		);
	} else {
		// ~75k tokens of old history; grow adds ~87.5k, crossing 78% (~82%) but not Pi's 92% default.
		sessionManager.appendMessage({
			role: "user",
			content: HISTORY_MARKER + "h".repeat(300_000),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(
			response([{ type: "text", text: "Previous task completed." }], 76_000, false),
		);
	}

	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager,
		settingsManager,
		noTools: "builtin",
	});
	try {
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({});
		session.agent.streamFunction = (_model, context) => {
			const head = context.messages[0];
			if (
				head?.role === "system" &&
				typeof head.content === "string" &&
				head.content.includes("context summarization assistant")
			) {
				return streamSummary("preflight-compact");
			}
			const text = JSON.stringify(context.messages);
			requests.push({
				summary: text.includes(SUMMARY),
				history: text.includes(HISTORY_MARKER),
				toolOutput: text.includes("x".repeat(10_000)),
			});
			const n = requests.length;
			trace.push(`request:${n}`);
			if (mode === "preflight") {
				const message = response([{ type: "text", text: "DONE" }], 20_000, false);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			}
			const toolUse = n < (mode === "batch" ? 2 : 3);
			const names =
				mode === "batch" ? ["grow", "finish"] : [n === 1 ? "grow" : "finish"];
			const message = response(
				toolUse
					? names.map((name) => ({
							type: "toolCall",
							id: `${name}-${n}`,
							name,
							arguments: {},
						}))
					: [{ type: "text", text: "DONE" }],
				n === 1 ? 76_000 : mode === "below-threshold" ? 164_000 : 89_000,
				toolUse,
			);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({
				type: "done",
				reason: message.stopReason as "toolUse" | "stop",
				message,
			});
			return stream;
		};

		await session.prompt(
			mode === "preflight"
				? "Continue and say DONE."
				: "Execute grow, then finish, then say DONE.",
		);
		assert.equal(session.getLastAssistantText(), "DONE", "same task reaches completion");
		const expectedRequests = mode === "preflight" ? 1 : mode === "batch" ? 2 : 3;
		assert.equal(requests.length, expectedRequests, "no injected extra continuation");
		if (mode !== "preflight") {
			assert.equal(
				trace.filter((item) => item === "tool:grow").length,
				1,
				"tool work is not replayed",
			);
			assert.equal(trace.filter((item) => item === "tool:finish").length, 1);
		}
		return {
			trace,
			summaryCount,
			requests,
			entries: sessionManager.getBranch(),
		};
	} finally {
		session.dispose();
		await settingsManager.flush();
	}
}

test("SDK: below configured threshold does not compact mid-run", async () => {
	const { summaryCount, requests, entries } = await runScenario("below-threshold", 95);
	assert.equal(summaryCount, 0);
	assert.deepEqual(requests[1], { summary: false, history: true, toolOutput: true });
	assert.ok(!entries.some((entry) => entry.type === "compaction"));
});

test("SDK: turn_end auto-compacts at threshold without align on and continues seamlessly", async () => {
	const { trace, summaryCount, requests, entries } = await runScenario("midrun", 78);
	// One split-turn compaction calls streamSimple twice (history + turn-prefix) and appends 1 compaction entry.
	assert.equal(summaryCount, 2);
	assert.deepEqual(
		requests[1],
		{ summary: true, history: false, toolOutput: true },
		"next model request receives summary plus recent tool results, not summarized history",
	);
	assert.ok(trace.indexOf("tool:grow") < trace.indexOf("midrun-compact"));
	assert.ok(trace.indexOf("midrun-compact") < trace.indexOf("request:2"));
	assert.ok(trace.indexOf("request:2") < trace.indexOf("tool:finish"));
	assert.ok(
		!trace.some((item) => item.startsWith("pi-before-compact:")),
		"Pi built-in compaction does not double-compact",
	);
	assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
	const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
	assert.equal(settings.compaction?.modelOverrides, undefined, "alignment remains opt-in");
	assert.equal(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).alignPiThreshold, undefined);
});

test("SDK: sibling tools finish as a batch before mid-run compaction, then the next request uses its summary", async () => {
	const { trace, summaryCount, requests, entries } = await runScenario("batch", 78);
	assert.equal(summaryCount, 2);
	assert.ok(trace.indexOf("tool:grow") < trace.indexOf("midrun-compact"));
	assert.ok(trace.indexOf("tool:finish") < trace.indexOf("midrun-compact"));
	assert.ok(trace.indexOf("midrun-compact") < trace.indexOf("request:2"));
	assert.deepEqual(requests[1], { summary: true, history: false, toolOutput: true });
	assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
});

test("SDK: preflight input compaction summarizes before the first request and still sends the prompt", async () => {
	const { trace, summaryCount, requests, entries } = await runScenario("preflight", 78);
	assert.equal(summaryCount, 1);
	assert.ok(trace.indexOf("pi-before-compact:manual") >= 0);
	assert.ok(trace.indexOf("preflight-compact") < trace.indexOf("request:1"));
	assert.equal(requests[0]!.summary, true);
	assert.equal(requests[0]!.history, false);
	assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
});

test("SDK: align on/off persists reserveTokens and preserves user keepRecentTokens across reload", async () => {
	const cwd = mkdtempSync(join(root, "workspace-align-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
	const baseModel = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(baseModel);
	const model = { ...baseModel, contextWindow: CONTEXT_WINDOW };
	const modelKey = `${model.provider}/${model.id}`;

	writeFileSync(CONFIG_FILE, JSON.stringify({ threshold: 78 }));
	writeFileSync(
		SETTINGS_FILE,
		JSON.stringify({
			compaction: {
				enabled: true,
				modelOverrides: {
					[modelKey]: { keepRecentTokens: 1000 },
				},
			},
			retry: { enabled: false },
		}),
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [createExtension],
	});
	await resourceLoader.reload();

	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		noTools: "builtin",
	});
	try {
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({});

		await session.prompt("/compact-threshold align on");
		let disk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		assert.deepEqual(disk.compaction.modelOverrides[modelKey], {
			keepRecentTokens: 1000,
			reserveTokens: 44_000,
		});
		assert.equal(
			settingsManager.getCompactionSettings(model).reserveTokens,
			DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			"writing settings must not pretend the active runtime already reloaded",
		);

		await settingsManager.reload();
		assert.deepEqual(settingsManager.getCompactionSettings(model), {
			enabled: true,
			reserveTokens: 44_000,
			keepRecentTokens: 1000,
		});

		await session.prompt("/compact-threshold align off");
		disk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		assert.deepEqual(disk.compaction.modelOverrides[modelKey], {
			keepRecentTokens: 1000,
		});

		await settingsManager.reload();
		assert.deepEqual(settingsManager.getCompactionSettings(model), {
			enabled: true,
			reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: 1000,
		});
	} finally {
		session.dispose();
		await settingsManager.flush();
	}
});
