import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, type PendingToolCall, type ToolBridge } from "../claude-code/tool-bridge.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../claude-code/transcript.ts";
import { AcpConnection, AcpRequestError, methodNotFound } from "./acp.ts";
import { parseSessionUpdate, withoutToolSummary, type AcpEvent, type AcpPromptResult, type AcpUsage } from "./acp-events.ts";
import { getAgyBinary } from "./binary.ts";
import { inspectAgyInstallation } from "./installation.ts";

export class AgyLaunchError extends Error {}

export type RunAgy = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) =>
	ChildProcessWithoutNullStreams | null | Promise<ChildProcessWithoutNullStreams | null>;

/** agy abandons an MCP call after a hard three-minute deadline (progress does not extend it)
 * and then retries it on its own. A held call is therefore released well before that: the
 * process is killed, and the answer starts a fresh process that replays the transcript. */
export const AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS = 150_000;
export const agyLiveProcessIdleTimeoutMs = { current: AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS };

/** Parallel calls reach the bridge a few milliseconds apart; admit them as one batch. */
const ADMISSION_SETTLE_MS = 40;

/** The intent and its MCP request arrive within milliseconds of each other, in either order.
 * Anything still unpaired after this is a compatibility failure, never a silent hang. */
export const agyPairingTimeoutMs = { current: 2_000 };

/** agy exposes MCP tools to its model as mcp_<server>_<tool>. */
const AGY_TOOL_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;

export const AgyError = {
	CliNotFound: "agy CLI not found",
	StartFailed: "agy CLI failed to start",
	Aborted: "Request was aborted",
	NoAppend: "agy did not offer system-prompt append; LearnHarness cannot deliver its instructions",
	Refused: "The model refused to complete the request",
} as const;

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
};

export function toAgyArgs(geminiDir: string): string[] {
	// An empty, private Gemini directory keeps the learner's own GEMINI.md rules, skills, and
	// MCP servers out of the tutor while the CLI's Google sign-in (stored elsewhere) still works.
	return ["acp", "--gemini-dir", geminiDir, "--include-default-customizations=false", "--disable-telemetry"];
}

/** Without this frame, a replayed transcript reads as one new request and the model re-runs
 * tool calls whose results are already in it (observed with Gemini Flash). */
export const REPLAY_PREAMBLE = "The conversation so far is replayed below, oldest first. Every [tool call] in it has already run and its [tool result] follows it; never repeat those calls. Continue as the assistant from the end of the transcript.";

export function isReplay(messages: Message[]): boolean {
	return messages.filter((message) => message.role !== "system").length > 1;
}

export function toAcpContent(blocks: ClaudeContentBlock[]): unknown[] {
	return blocks.map((block) => block.type === "text"
		? { type: "text", text: block.text }
		: { type: "image", mimeType: block.source.media_type, data: block.source.data });
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** One pi assistant message built from ACP chunks. */
class AgyTurn {
	private readonly output: AssistantMessage;
	private open: { index: number; type: "text" | "thinking" } | null = null;
	started = false;
	finished = false;

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage { return this.output; }

	append(type: "text" | "thinking", delta: string): void {
		if (this.finished) return;
		this.start();
		if (this.open?.type !== type) {
			this.closeBlock();
			const contentIndex = this.output.content.length;
			this.output.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex, partial: this.output });
			this.open = { index: contentIndex, type };
		}
		const contentIndex = this.open.index;
		const block = this.output.content[contentIndex]!;
		if (block.type === "text") {
			block.text += delta;
			this.stream.push({ type: "text_delta", contentIndex, delta, partial: this.output });
		} else if (block.type === "thinking") {
			block.thinking += delta;
			this.stream.push({ type: "thinking_delta", contentIndex, delta, partial: this.output });
		}
	}

	admit(calls: ToolCall[]): void {
		this.start();
		this.closeBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.done();
	}

	complete(stopReason: StopReason, usage: AcpUsage | undefined): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		this.setUsage(usage);
		this.output.stopReason = stopReason;
		this.done();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private setUsage(usage: AcpUsage | undefined): void {
		if (!usage) return;
		const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
		const cacheRead = count(usage.cachedReadTokens);
		const cacheWrite = count(usage.cachedWriteTokens);
		// ACP's inputTokens includes cached tokens; pi counts them separately. Thought tokens are already in outputTokens.
		const input = Math.max(0, count(usage.inputTokens) - cacheRead - cacheWrite);
		const output = count(usage.outputTokens);
		Object.assign(this.output.usage, { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeBlock(): void {
		if (!this.open) return;
		const { index, type } = this.open;
		const block = this.output.content[index]!;
		this.open = null;
		if (type === "text" && block.type === "text") this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
		if (type === "thinking" && block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
	}

	private done(): void {
		this.finished = true;
		this.stream.push({ type: "done", reason: this.output.stopReason as "stop" | "length" | "toolUse", message: this.output });
		this.stream.end();
	}
}

type TurnFiles = { cwd: string; geminiDir: string };

async function createTurnFiles(): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
	try {
		return { cwd, geminiDir: await mkdtemp(join(tmpdir(), "agy-gemini-")) };
	} catch (error) {
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

type Admission = { intent: ToolCall; call: PendingToolCall };

class AgyProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private readonly rpc: AcpConnection;
	private acpSessionId: string | undefined;
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private settleTimer: NodeJS.Timeout | undefined;
	private pairingTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	/** Streamed harness tool intents not yet matched to an authenticated MCP request. */
	private readonly intents = new Map<string, ToolCall>();
	private readonly matchedCalls = new Set<string>();
	private ready: Admission[] = [];
	private admitted: Admission[] = [];
	private pendingError: string | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: AgyTurn,
		private readonly toolNames: ReadonlySet<string>,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {
		this.rpc = new AcpConnection(child.stdout, child.stdin,
			(method, params) => this.handleNotification(method, params),
			(method, params) => this.handleRequest(method, params),
			(error) => this.fail(error.message));
	}

	start(model: string, systemPrompt: string, prompt: unknown[], signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.turn.fail(AgyError.StartFailed, "error");
			this.handleClose(AgyError.StartFailed);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));
		this.setSignal(signal);
		if (this.stopping) return;
		this.run(model, systemPrompt, prompt).catch((error: unknown) => {
			if (this.stopping) return;
			this.fail(error instanceof AcpRequestError ? `agy ${error.method} failed: ${error.message}` : AgyError.StartFailed);
		});
	}

	private async run(model: string, systemPrompt: string, prompt: unknown[]): Promise<void> {
		const init = await this.rpc.request<{ agentCapabilities?: { _meta?: { antigravity?: { systemPrompt?: { append?: unknown } } } } }>("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		// Without append, the tutor would run on agy's prompt alone. Fail closed.
		if (init?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append !== true) { this.fail(AgyError.NoAppend); return; }
		const session = await this.rpc.request<{ sessionId?: unknown }>("session/new", {
			cwd: this.files.cwd,
			mcpServers: [{ type: "http", name: BRIDGE_SERVER_NAME, url: this.bridge.url, headers: [{ name: "Authorization", value: this.bridge.authorization }] }],
			_meta: { antigravity: { systemPrompt: { append: systemPrompt } } },
		});
		if (typeof session?.sessionId !== "string") { this.fail("agy session/new returned no session"); return; }
		this.acpSessionId = session.sessionId;
		await this.rpc.request("session/set_model", { sessionId: this.acpSessionId, modelId: model });
		if (this.stopping) return;
		const result = await this.rpc.request<AcpPromptResult>("session/prompt", { sessionId: this.acpSessionId, prompt });
		this.handlePromptResult(result ?? {});
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every(({ intent }) => results.some((result) => result.toolCallId === intent.id && result.toolName === intent.name));
	}

	continueTurn(turn: AgyTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const { intent, call } of admitted) {
			this.bridge.resolveToolCall(call, results.find((result) => result.toolCallId === intent.id)!);
		}
		// Parallel calls beyond the first batch were already waiting at the bridge.
		this.flushAdmissions();
	}

	consumeFailure(owner: symbol, turn: AgyTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	kill(): void {
		removeLiveProcess(this);
		clearTimeout(this.settleTimer);
		clearTimeout(this.pairingTimer);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		if (this.acpSessionId) this.rpc.notify("session/cancel", { sessionId: this.acpSessionId });
		this.rpc.close();
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		// After a batch was handed to pi, keep the failure for its continuation instead of
		// letting a fresh replay hide it.
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this, agyLiveProcessIdleTimeoutMs.current);
	}

	/** The bridge received an authenticated MCP request. */
	onBridgeCall(): void {
		this.match();
	}

	/** agy aborted an MCP request (its own deadline or cancellation). */
	onBridgeCancel(call: PendingToolCall): void {
		if (this.admitted.some((admission) => admission.call === call)) {
			this.fail("agy abandoned a harness tool call before its result was ready");
			return;
		}
		this.ready = this.ready.filter((admission) => admission.call !== call);
		this.matchedCalls.delete(call.id);
	}

	private handleRequest(method: string, params: unknown): unknown {
		if (method === "session/request_permission") {
			// Any permission request is a built-in tool: never grant it.
			const options = (params as { options?: { optionId?: string; kind?: string }[] } | undefined)?.options ?? [];
			const reject = options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind?.startsWith("reject"));
			const name = (params as { toolCall?: { name?: unknown; title?: unknown } } | undefined)?.toolCall;
			setImmediate(() => this.refuseBuiltIn(typeof name?.name === "string" ? name.name : typeof name?.title === "string" ? name.title : "unknown"));
			return reject?.optionId ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
		}
		throw methodNotFound(method);
	}

	private handleNotification(method: string, params: unknown): void {
		if (this.stopping || method !== "session/update" || !this.acpSessionId) return;
		const event = parseSessionUpdate(params, this.acpSessionId);
		if (event) this.handleEvent(event);
	}

	private handleEvent(event: AcpEvent): void {
		switch (event.type) {
			case "text":
			case "thinking":
				// Moving on while harness calls wait for results means the CLI did not honor the wait.
				if (this.turn.finished) { this.fail("agy moved on while harness tool calls were waiting for results"); return; }
				this.turn.append(event.type, event.text);
				return;

			case "toolCall": {
				const name = event.name.startsWith(AGY_TOOL_PREFIX) ? event.name.slice(AGY_TOOL_PREFIX.length) : null;
				if (name === null || !this.toolNames.has(name)) { this.refuseBuiltIn(event.name); return; }
				if (this.intents.has(event.id) || this.admitted.some(({ intent }) => intent.id === event.id)) return;
				this.intents.set(event.id, { type: "toolCall", id: event.id, name, arguments: event.arguments });
				this.match();
				return;
			}

			case "toolCallUpdate":
				if (event.status === "failed" && this.admitted.some(({ intent }) => intent.id === event.id)) {
					this.fail("agy abandoned a harness tool call before its result was ready");
				}
				return;
		}
	}

	private refuseBuiltIn(name: string): void {
		if (this.stopping) return;
		this.fail(`agy tried to use its built-in tool "${name}". LearnHarness allows only its own tools, so this turn was stopped.`);
	}

	/** Pair authenticated MCP requests with streamed intents: same tool, same arguments.
	 * The intent supplies the call id; the authenticated request supplies the executed arguments. */
	private match(): void {
		if (this.stopping) return;
		for (const call of this.bridge.getPendingToolCalls()) {
			if (this.matchedCalls.has(call.id) || this.admitted.some((admission) => admission.call === call)) continue;
			const intent = [...this.intents.values()].find((candidate) => candidate.name === call.name
				&& (isDeepStrictEqual(candidate.arguments, call.arguments) || isDeepStrictEqual(withoutToolSummary(candidate.arguments), call.arguments)));
			if (!intent) continue;
			this.intents.delete(intent.id);
			this.matchedCalls.add(call.id);
			this.ready.push({ intent: { ...intent, arguments: call.arguments }, call });
		}
		if (this.ready.length > 0 && !this.settleTimer) {
			this.settleTimer = setTimeout(() => { this.settleTimer = undefined; this.flushAdmissions(); }, ADMISSION_SETTLE_MS);
		}
		const unpaired = this.intents.size > 0 || this.unpairedCalls().length > 0;
		if (!unpaired) { clearTimeout(this.pairingTimer); this.pairingTimer = undefined; }
		else if (!this.pairingTimer) {
			this.pairingTimer = setTimeout(() => {
				this.pairingTimer = undefined;
				if (this.intents.size > 0 || this.unpairedCalls().length > 0) this.fail("agy compatibility error: MCP call does not match its streamed tool intent");
			}, agyPairingTimeoutMs.current);
		}
	}

	private unpairedCalls(): PendingToolCall[] {
		return this.bridge.getPendingToolCalls().filter((call) => !this.matchedCalls.has(call.id) && !this.admitted.some((admission) => admission.call === call));
	}

	/** Only authenticated MCP requests, never streamed intent alone, admit side effects. */
	private flushAdmissions(): void {
		if (this.stopping || this.turn.finished || this.ready.length === 0 || this.admitted.length > 0) return;
		this.admitted = this.ready;
		this.ready = [];
		this.toolCallIds = this.admitted.map(({ intent }) => intent.id);
		this.turn.admit(this.admitted.map(({ intent }) => intent));
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this, agyLiveProcessIdleTimeoutMs.current);
		else this.kill(); // No trusted scope: return the batch, then use fresh replay.
	}

	private handlePromptResult(result: AcpPromptResult): void {
		if (this.stopping) return;
		if (this.admitted.length > 0 || this.ready.length > 0 || this.intents.size > 0) {
			this.fail("agy ended its turn without completing harness tool calls");
			return;
		}
		if (this.turn.finished) { this.kill(); return; }
		const reason = result.stopReason ?? "";
		if (reason === "cancelled") this.turn.fail(AgyError.Aborted, "aborted");
		else if (reason === "refusal") this.turn.fail(AgyError.Refused, "error");
		else if (STOP_REASONS[reason]) this.turn.complete(STOP_REASONS[reason], result.usage);
		else this.turn.fail(`agy ended the turn with an unhandled stop reason: ${reason || "none"}`, "error");
		this.kill();
	}

	private readonly abort = () => {
		this.turn.fail(AgyError.Aborted, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		clearTimeout(this.settleTimer);
		clearTimeout(this.pairingTimer);
		this.rpc.close();
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this, agyLiveProcessIdleTimeoutMs.current);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim()) console.error("agy CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		Promise.all([
			this.bridge.close(),
			rm(this.files.cwd, { recursive: true, force: true }),
			rm(this.files.geminiDir, { recursive: true, force: true }),
		]).catch((error: unknown) => console.error("agy CLI cleanup failed:", error));
	}
}

function continueLiveProcess(turn: AgyTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AgyProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	runAgy: RunAgy,
	turn: AgyTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(AgyError.Aborted, "aborted"); return; }
	const input = toClaudeInput(context.messages);
	let agyProcess: AgyProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		onCall: () => agyProcess?.onBridgeCall(),
		onError: (error) => agyProcess?.fail(error.message),
		onCancel: (call) => agyProcess?.onBridgeCancel(call),
	}, "generated");
	let files: TurnFiles;
	try {
		files = await createTurnFiles();
	} catch (error) {
		await bridge.close();
		throw error;
	}
	const cleanup = () => Promise.all([bridge.close(), rm(files.cwd, { recursive: true, force: true }), rm(files.geminiDir, { recursive: true, force: true })]);
	if (options?.signal?.aborted) { turn.fail(AgyError.Aborted, "aborted"); await cleanup(); return; }

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runAgy(toAgyArgs(files.geminiDir), { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await cleanup();
		throw error;
	}
	if (!child) {
		turn.fail(AgyError.CliNotFound, "error");
		await cleanup();
		return;
	}

	agyProcess = new AgyProcess(child, bridge, files, turn, new Set(input.tools.map((tool) => tool.name)), owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	const prompt = toAcpContent(input.userContent);
	if (isReplay(context.messages)) prompt.unshift({ type: "text", text: REPLAY_PREAMBLE });
	agyProcess.start(model.id, input.systemPrompt, prompt, options?.signal);
}

export function createAntigravityStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AgyTurn(stream, model);
		const env = externalCliEnv();
		// A held process must not outlive an authentication/routing environment change.
		const configuration = { request: configurationForReuse(model, context, ""), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runAgy, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			const aborted = options?.signal?.aborted === true;
			turn.fail(aborted ? AgyError.Aborted : error instanceof AgyLaunchError ? error.message : AgyError.StartFailed, aborted ? "aborted" : "error");
		});
		return stream;
	};
}

/** Production launcher: the installed CLI, version-checked per fresh process. */
export function createAgyLauncher({
	findBinary = getAgyBinary,
	inspect = inspectAgyInstallation,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	inspect?: typeof inspectAgyInstallation;
	spawnProcess?: typeof spawn;
} = {}): RunAgy {
	return async (args, options) => {
		if (options.signal?.aborted) throw new AgyLaunchError(AgyError.Aborted);
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspect(() => binary);
		if (status.state === "update-required") {
			throw new AgyLaunchError(`Antigravity CLI ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; run \`agy update\` outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new AgyLaunchError("Antigravity CLI's version could not be checked. Check your installation outside LearnHarness and try again.");
		}
		if (options.signal?.aborted) throw new AgyLaunchError(AgyError.Aborted);
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe", windowsHide: true });
	};
}

export const streamAntigravity = createAntigravityStreamFunction(createAgyLauncher());
