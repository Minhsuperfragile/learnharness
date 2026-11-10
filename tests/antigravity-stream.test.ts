/**
 * Antigravity CLI (agy) provider: ACP stream adaptation, MCP admission, process reuse,
 * replay, fail-closed refusal of agy's built-in tools, and installation parsing.
 *
 * The runAgy seam spawns tests/fixtures/antigravity/fake-agy.mjs, which speaks ACP on stdio
 * and calls harness tools through the real loopback MCP bridge, so process plumbing,
 * authentication headers, and the intent/MCP pairing all run end to end.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { AgyError, REPLAY_PREAMBLE, agyLiveProcessIdleTimeoutMs, agyPairingTimeoutMs, createAntigravityStreamFunction, toAgyArgs, type RunAgy } from "../src/agent/antigravity/stream.ts";
import { inspectAgyInstallation, parseAgyModels } from "../src/agent/antigravity/installation.ts";
import { resolveAgyBinary } from "../src/agent/antigravity/binary.ts";
import { toAntigravityModel } from "../src/agent/antigravity/provider.ts";
import { withoutToolSummary } from "../src/agent/antigravity/acp-events.ts";
import { ANTIGRAVITY_MINIMUM_VERSION, isExternalCliProvider } from "../src/core/contracts/antigravity.ts";

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const NOTE_TOOL: Tool = { name: "record_note", description: "Record a note", parameters: { type: "object", properties: { text: { type: "string" } } } };
const MODEL = toAntigravityModel({ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" });

type Launch = { args: string[]; cwd: string; sent: string[] };

function fakeLauncher(scenario: string): { run: RunAgy; launches: Launch[]; log: string; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), "fake-agy-log-"));
	const log = join(dir, "acp.jsonl");
	const launches: Launch[] = [];
	return {
		launches,
		log,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
		run: (args, options) => {
			const launch: Launch = { args, cwd: options.cwd, sent: [] };
			launches.push(launch);
			const child = spawn(process.execPath, [FAKE_AGY], {
				cwd: options.cwd,
				env: { ...options.env, FAKE_AGY_SCENARIO: scenario, FAKE_AGY_LOG: log },
				stdio: "pipe",
			});
			// Record LearnHarness's writes at the source: the fake may be killed before it logs them.
			const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
			child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => { launch.sent.push(String(chunk)); return write(chunk, ...rest); }) as typeof child.stdin.write;
			return child;
		},
	};
}

function readLog(log: string): Record<string, unknown>[] {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

async function collect(stream: AssistantMessageEventStream): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	return { events, message: message! };
}

function toolResult(message: AssistantMessage, text: string): ToolResultMessage[] {
	return message.content.flatMap((block) => block.type === "toolCall"
		? [{ role: "toolResult", toolCallId: block.id, toolName: block.name, content: [{ type: "text", text: `${text}:${JSON.stringify(block.arguments)}` }], isError: false, timestamp: 0 } satisfies ToolResultMessage]
		: []);
}

const HI: Message = { role: "user", content: "hi", timestamp: 0 };

test("a text turn streams thinking and text, maps usage, and sends LearnHarness's prompt as an append", async () => {
	const fake = fakeLauncher("text");
	try {
		const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI], tools: [NOTE_TOOL] });
		const { events, message } = await collect(createAntigravityStreamFunction(fake.run)(MODEL, context));

		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content, [{ type: "thinking", thinking: "Thinking" }, { type: "text", text: "Hello" }]);
		assert.deepEqual(events.map((event) => event.type), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		assert.deepEqual({ input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead }, { input: 60, output: 10, cacheRead: 40 });

		const [launch] = fake.launches;
		assert.equal(launch!.args[0], "acp");
		assert.deepEqual(launch!.args.slice(3), ["--include-default-customizations=false", "--disable-telemetry"]);
		const geminiDir = launch!.args[2]!;
		assert.deepEqual(toAgyArgs(geminiDir), launch!.args);

		const sessionNew = readLog(fake.log).find((line) => line.method === "session/new") as { params: { cwd: string; mcpServers: { type: string; name: string; url: string; headers: { name: string; value: string }[] }[]; _meta: unknown } };
		assert.equal(sessionNew.params.cwd, launch!.cwd);
		assert.deepEqual(sessionNew.params._meta, { antigravity: { systemPrompt: { append: "You are a tutor." } } });
		const [server] = sessionNew.params.mcpServers;
		assert.equal(server!.type, "http");
		assert.equal(server!.name, "learnharness");
		assert.match(server!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		assert.match(server!.headers[0]!.value, /^Bearer [0-9a-f]{64}$/);
		const setModel = readLog(fake.log).find((line) => line.method === "session/set_model") as { params: { modelId: string } };
		assert.equal(setModel.params.modelId, "gemini-3.8-flash-low");

		// Temporary working and Gemini directories are removed after the process closes.
		for (let i = 0; i < 50 && (existsSync(launch!.cwd) || existsSync(geminiDir)); i++) await sleep(20);
		assert.equal(existsSync(launch!.cwd), false);
		assert.equal(existsSync(geminiDir), false);
	} finally {
		fake.cleanup();
	}
});

for (const scenario of ["tool", "tool-late-intent"]) {
	test(`${scenario}: an authenticated MCP call is admitted under the streamed id, and the held process continues`, async () => {
		const fake = fakeLauncher(scenario);
		try {
			const stream = createAntigravityStreamFunction(fake.run);
			const context = normalizeContext({ systemPrompt: "p", messages: [HI], tools: [NOTE_TOOL] });
			const first = await collect(stream(MODEL, context, { sessionId: "chat-1" }));
			assert.equal(first.message.stopReason, "toolUse");
			assert.deepEqual(first.message.content, [
				{ type: "text", text: "Let me note that." },
				// toolSummary is agy display text and never reaches the harness.
				{ type: "toolCall", id: "call_1", name: "record_note", arguments: { text: "x" } },
			]);

			const messages = [...context.messages, first.message, ...toolResult(first.message, "stored")];
			const second = await collect(stream(MODEL, normalizeContext({ messages }), { sessionId: "chat-1" }));
			assert.equal(second.message.stopReason, "stop");
			assert.deepEqual(second.message.content, [{ type: "text", text: "Done: stored:{\"text\":\"x\"}" }]);
			assert.equal(fake.launches.length, 1, "the held process answered the continuation");
		} finally {
			fake.cleanup();
		}
	});
}

test("parallel calls are admitted as one batch", async () => {
	const fake = fakeLauncher("parallel");
	try {
		const stream = createAntigravityStreamFunction(fake.run);
		const context = normalizeContext({ systemPrompt: "p", messages: [HI], tools: [NOTE_TOOL] });
		const first = await collect(stream(MODEL, context, { sessionId: "chat-2" }));
		assert.equal(first.message.stopReason, "toolUse");
		const calls = first.message.content.filter((block) => block.type === "toolCall");
		assert.deepEqual(calls.map((call) => call.type === "toolCall" ? [call.id, call.arguments] : null).sort(), [["call_1", { text: "a" }], ["call_2", { text: "b" }]]);

		const second = await collect(stream(MODEL, normalizeContext({ messages: [...context.messages, first.message, ...toolResult(first.message, "ok")] }), { sessionId: "chat-2" }));
		assert.equal(second.message.stopReason, "stop");
		assert.match((second.message.content[0] as { text: string }).text, /^Done: ok:\{"text":"a"\} \+ ok:\{"text":"b"\}$/);
		assert.equal(fake.launches.length, 1);
	} finally {
		fake.cleanup();
	}
});

test("after the idle bound the held process is released and the answer replays the transcript", async () => {
	const fake = fakeLauncher("tool");
	const previous = agyLiveProcessIdleTimeoutMs.current;
	agyLiveProcessIdleTimeoutMs.current = 50;
	try {
		const stream = createAntigravityStreamFunction(fake.run);
		const context = normalizeContext({ systemPrompt: "p", messages: [HI], tools: [NOTE_TOOL] });
		const first = await collect(stream(MODEL, context, { sessionId: "chat-3" }));
		assert.equal(first.message.stopReason, "toolUse");
		await sleep(300);

		const second = stream(MODEL, normalizeContext({ messages: [...context.messages, first.message, ...toolResult(first.message, "stored")] }), { sessionId: "chat-3" });
		// The fresh fake repeats its scenario and calls the tool again; inspect the replayed prompt.
		const replayed = await collect(second);
		assert.equal(fake.launches.length, 2, "a fresh process served the answer");
		assert.equal(replayed.message.stopReason, "toolUse");
		const prompts = readLog(fake.log).filter((line) => line.method === "session/prompt") as { params: { prompt: { type: string; text?: string }[] } }[];
		const replay = prompts[1]!.params.prompt;
		assert.equal(replay[0]!.text, REPLAY_PREAMBLE);
		assert.match(replay[1]!.text!, /\[user\]\nhi[\s\S]*\[tool call record_note\] \{"text":"x"\}[\s\S]*\[tool result record_note\]\nstored/);
	} finally {
		agyLiveProcessIdleTimeoutMs.current = previous;
		fake.cleanup();
	}
});

test("any built-in agy tool stops the turn", async () => {
	const fake = fakeLauncher("builtin");
	try {
		const { message } = await collect(createAntigravityStreamFunction(fake.run)(MODEL, normalizeContext({ messages: [HI], tools: [NOTE_TOOL] })));
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage!, /built-in tool "read_file"/);
	} finally {
		fake.cleanup();
	}
});

test("permission requests are rejected and stop the turn", async () => {
	const fake = fakeLauncher("permission");
	try {
		const { message } = await collect(createAntigravityStreamFunction(fake.run)(MODEL, normalizeContext({ messages: [HI], tools: [] })));
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage!, /built-in tool "run_command"/);
		const answer = fake.launches[0]!.sent.map((line) => JSON.parse(line) as { id?: number; result?: unknown }).find((line) => line.id === 1000);
		assert.deepEqual(answer?.result, { outcome: { outcome: "selected", optionId: "deny" } });
	} finally {
		fake.cleanup();
	}
});

test("an MCP call that matches no streamed intent fails instead of hanging", async () => {
	const fake = fakeLauncher("mismatch");
	const previous = agyPairingTimeoutMs.current;
	agyPairingTimeoutMs.current = 100;
	try {
		const { message } = await collect(createAntigravityStreamFunction(fake.run)(MODEL, normalizeContext({ messages: [HI], tools: [NOTE_TOOL] }), { sessionId: "chat-4" }));
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage!, /does not match its streamed tool intent/);
	} finally {
		agyPairingTimeoutMs.current = previous;
		fake.cleanup();
	}
});

test("a CLI without system-prompt append is refused", async () => {
	const fake = fakeLauncher("no-append");
	try {
		const { message } = await collect(createAntigravityStreamFunction(fake.run)(MODEL, normalizeContext({ systemPrompt: "p", messages: [HI] })));
		assert.equal(message.errorMessage, AgyError.NoAppend);
		assert.equal(readLog(fake.log).some((line) => line.method === "session/new"), false);
	} finally {
		fake.cleanup();
	}
});

test("refusal maps to an error; a missing CLI reports not found; abort reports aborted", async () => {
	const refusal = fakeLauncher("refusal");
	try {
		const { message } = await collect(createAntigravityStreamFunction(refusal.run)(MODEL, normalizeContext({ messages: [HI] })));
		assert.equal(message.errorMessage, AgyError.Refused);
	} finally {
		refusal.cleanup();
	}

	const missing = await collect(createAntigravityStreamFunction(() => null)(MODEL, normalizeContext({ messages: [HI] })));
	assert.equal(missing.message.errorMessage, AgyError.CliNotFound);

	const hang = fakeLauncher("hang");
	try {
		const controller = new AbortController();
		const pending = collect(createAntigravityStreamFunction(hang.run)(MODEL, normalizeContext({ messages: [HI] }), { signal: controller.signal }));
		await sleep(300);
		controller.abort();
		const { message } = await pending;
		assert.equal(message.stopReason, "aborted");
	} finally {
		hang.cleanup();
	}
});

test("installation: version gate, model listing, binary discovery, and provider classification", async () => {
	assert.deepEqual(parseAgyModels("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\nbad id\tx\nclaude-sonnet-4-6\tdup\n"), [
		{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
	]);
	const status = (output: string) => inspectAgyInstallation(() => "agy", async () => output);
	assert.deepEqual(await status("1.5.3\n"), { state: "meets-minimum", version: "1.5.3", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });
	assert.equal((await status("1.10.0")).state, "meets-minimum");
	assert.equal((await status("1.5.2")).state, "update-required");
	assert.equal((await status("agy version unknown")).state, "version-unchecked");
	assert.equal((await inspectAgyInstallation(() => null)).state, "not-found");

	const found = resolveAgyBinary({
		env: { PATH: "", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
		platform: "win32",
		homeDir: "C:\\Users\\u",
		cwd: "C:\\",
		isExecutable: (candidate) => candidate === "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe",
	});
	assert.equal(found, "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe");

	assert.deepEqual(withoutToolSummary({ text: "x", toolSummary: "y" }), { text: "x" });
	assert.equal(isExternalCliProvider("antigravity"), true);
	assert.equal(isExternalCliProvider("claude-code"), true);
	assert.equal(isExternalCliProvider("openrouter"), false);
});
