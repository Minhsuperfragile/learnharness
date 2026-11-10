import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Newline-delimited JSON-RPC 2.0 over a child's stdio: the Agent Client Protocol transport. */

export class AcpRequestError extends Error {
	constructor(readonly method: string, readonly code: number | undefined, message: string) {
		super(message);
	}
}

type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void };

type RequestHandler = (method: string, params: unknown) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;

const METHOD_NOT_FOUND = -32601;

export class AcpConnection {
	private nextId = 0;
	private closed = false;
	private readonly pending = new Map<number, Pending>();

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
		private readonly onNotification: NotificationHandler,
		private readonly onRequest: RequestHandler,
		private readonly onProtocolError: (error: Error) => void,
	) {
		createInterface({ input }).on("line", (line) => {
			if (!line.trim()) return;
			try {
				this.handle(JSON.parse(line) as Record<string, unknown>);
			} catch {
				this.onProtocolError(new Error("agy emitted malformed ACP output"));
			}
		});
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.closed) return Promise.reject(new AcpRequestError(method, undefined, "ACP connection closed"));
		const id = ++this.nextId;
		const result = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return result;
	}

	notify(method: string, params: unknown): void {
		if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const { method, reject } of this.pending.values()) reject(new AcpRequestError(method, undefined, "ACP connection closed"));
		this.pending.clear();
	}

	private write(message: unknown): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	private handle(message: Record<string, unknown>): void {
		const { id, method } = message;
		if (typeof method === "string") {
			if (id === undefined || id === null) {
				this.onNotification(method, message.params);
				return;
			}
			this.answer(id, method, message.params);
			return;
		}
		if (typeof id !== "number") return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		const error = message.error as { code?: number; message?: string } | undefined;
		if (error) pending.reject(new AcpRequestError(pending.method, error.code, error.message ?? `${pending.method} failed`));
		else pending.resolve(message.result);
	}

	private answer(id: unknown, method: string, params: unknown): void {
		try {
			const result = this.onRequest(method, params);
			if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			const code = error instanceof AcpRequestError && error.code !== undefined ? error.code : METHOD_NOT_FOUND;
			if (!this.closed) this.write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : "request refused" } });
		}
	}
}

export function methodNotFound(method: string): AcpRequestError {
	return new AcpRequestError(method, METHOD_NOT_FOUND, `LearnHarness does not provide ${method}`);
}
