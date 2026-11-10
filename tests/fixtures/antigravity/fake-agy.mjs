// A synthetic `agy acp` for tests/antigravity-stream.test.ts. It speaks newline-delimited
// JSON-RPC (ACP) on stdio and, like the real CLI, calls harness tools through the MCP server
// LearnHarness passes in session/new. The scenario comes from FAKE_AGY_SCENARIO; every
// received ACP message is appended to FAKE_AGY_LOG as one JSON line.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scenario = process.env.FAKE_AGY_SCENARIO ?? "text";
const log = process.env.FAKE_AGY_LOG;
const SESSION = "fake-session";
let nextId = 1000;
const waiting = new Map();
let mcp;
let mcpServer;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: value } });
const chunk = (sessionUpdate, text) => update({ sessionUpdate, content: { type: "text", text } });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
const toolCall = (toolCallId, name, rawInput) => update({ sessionUpdate: "tool_call", toolCallId, name, rawInput: { ...rawInput, toolSummary: "Display text" }, status: "in_progress" });

function connectMcp() {
	// One shared client: parallel calls must not race two initializations.
	mcp ??= (async () => {
		const headers = Object.fromEntries(mcpServer.headers.map(({ name, value }) => [name, value]));
		const client = new Client({ name: "fake-agy", version: "1.0.0" });
		await client.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url), { requestInit: { headers } }));
		return client;
	})();
	return mcp;
}

async function callTool(name, args) {
	const client = await connectMcp();
	const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
	return result.content.map((block) => block.text ?? "").join("");
}

const usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 40, cachedWriteTokens: 0, thoughtTokens: 3, totalTokens: 110 };

async function prompt(id) {
	switch (scenario) {
		case "text":
			chunk("agent_thought_chunk", "Thinking");
			chunk("agent_message_chunk", "Hel");
			chunk("agent_message_chunk", "lo");
			send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
			return;

		case "tool":
		case "tool-late-intent":
		case "parallel": {
			chunk("agent_message_chunk", "Let me note that.");
			if (scenario === "parallel") {
				toolCall("call_1", "mcp_learnharness_record_note", { text: "a" });
				toolCall("call_2", "mcp_learnharness_record_note", { text: "b" });
				const results = await Promise.all([callTool("record_note", { text: "a" }), callTool("record_note", { text: "b" })]);
				chunk("agent_message_chunk", `Done: ${results.join(" + ")}`);
			} else {
				let result;
				if (scenario === "tool-late-intent") {
					const pending = callTool("record_note", { text: "x" });
					setTimeout(() => toolCall("call_1", "mcp_learnharness_record_note", { text: "x" }), 20);
					result = await pending;
				} else {
					toolCall("call_1", "mcp_learnharness_record_note", { text: "x" });
					result = await callTool("record_note", { text: "x" });
				}
				update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
				chunk("agent_message_chunk", `Done: ${result}`);
			}
			send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
			return;
		}

		case "mismatch":
			toolCall("call_1", "mcp_learnharness_record_note", { text: "x" });
			await callTool("record_note", { text: "something else" });
			return;

		case "builtin":
			toolCall("call_9", "read_file", { Path: "C:/secret.txt" });
			return; // the real CLI would read the file; the test expects LearnHarness to stop the turn

		case "permission": {
			const answer = await ask("session/request_permission", {
				sessionId: SESSION,
				toolCall: { toolCallId: "call_7", name: "run_command", title: "Run dir" },
				options: [
					{ optionId: "allow", kind: "allow_once", name: "Allow" },
					{ optionId: "deny", kind: "reject_once", name: "Deny" },
				],
			});
			if (log) appendFileSync(log, `${JSON.stringify({ permissionAnswer: answer })}\n`);
			return;
		}

		case "refusal":
			send({ jsonrpc: "2.0", id, result: { stopReason: "refusal" } });
			return;

		case "hang":
			return;
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (log) appendFileSync(log, `${line}\n`);
	if (message.method === undefined && waiting.has(message.id)) {
		waiting.get(message.id)(message.result ?? message.error);
		waiting.delete(message.id);
		return;
	}
	switch (message.method) {
		case "initialize":
			send({ jsonrpc: "2.0", id: message.id, result: {
				protocolVersion: 1,
				agentCapabilities: { promptCapabilities: { image: true }, _meta: scenario === "no-append" ? {} : { antigravity: { systemPrompt: { append: true } } } },
			} });
			return;
		case "session/new":
			mcpServer = message.params.mcpServers[0];
			send({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION } });
			return;
		case "session/set_model":
			send({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		case "session/prompt":
			void prompt(message.id);
			return;
		case "session/cancel":
			return;
		default:
			if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
	}
});
