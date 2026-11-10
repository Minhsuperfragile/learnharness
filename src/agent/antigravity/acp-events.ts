import type { JsonObject } from "@earendil-works/pi-ai";

/** The session/update notifications the provider acts on. Everything else (commands, plans,
 * titles, config echoes, the echoed user message) is display metadata and is ignored. */
export type AcpEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: JsonObject }
	| { type: "toolCallUpdate"; id: string; status: string };

export type AcpUsage = {
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
};

export type AcpPromptResult = { stopReason?: string; usage?: AcpUsage };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function chunkText(content: unknown): string | null {
	return isRecord(content) && content.type === "text" && typeof content.text === "string" ? content.text : null;
}

export function parseSessionUpdate(params: unknown, sessionId: string): AcpEvent | null {
	if (!isRecord(params) || params.sessionId !== sessionId || !isRecord(params.update)) return null;
	const update = params.update;

	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = chunkText(update.content);
			return text ? { type: "text", text } : null;
		}

		case "agent_thought_chunk": {
			const text = chunkText(update.content);
			return text ? { type: "thinking", text } : null;
		}

		case "tool_call": {
			if (typeof update.toolCallId !== "string" || !update.toolCallId) return null;
			// agy reports the tool's own name in `name`; `title` is display text.
			const name = typeof update.name === "string" ? update.name : typeof update.title === "string" ? update.title : "";
			const args = isRecord(update.rawInput) ? update.rawInput : isRecord(update.args) ? update.args : {};
			return { type: "toolCall", id: update.toolCallId, name, arguments: args as JsonObject };
		}

		case "tool_call_update":
			if (typeof update.toolCallId !== "string" || typeof update.status !== "string") return null;
			return { type: "toolCallUpdate", id: update.toolCallId, status: update.status };

		default:
			return null;
	}
}

/** agy annotates every streamed tool call with a display-only `toolSummary` the MCP request never carries. */
export function withoutToolSummary(args: JsonObject): JsonObject {
	if (!("toolSummary" in args)) return args;
	const { toolSummary: _summary, ...rest } = args;
	return rest;
}
