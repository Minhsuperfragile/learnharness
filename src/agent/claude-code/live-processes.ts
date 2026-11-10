export type LiveProcess = { readonly owner: symbol; readonly sessionId: string | undefined; toolCallIds: string[]; kill(): void };

// Tools usually call back within seconds, but a question tool holds its call until the learner
// answers. Past this, the process is killed and the answer starts a fresh one with a full replay.
// It stays under MCP_TOOL_TIMEOUT so the process is killed before the CLI gives up on its own.
export const LIVE_PROCESS_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Test seam (runner.ts's pdfModelOverride idiom). */
export const liveProcessIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

// Each live process mapped to the timer that kills it if pi never calls back.
const liveProcesses = new Map<LiveProcess, NodeJS.Timeout>();

/** A provider whose CLI enforces its own shorter tool deadline passes its own idle bound. */
export function addLiveProcess(process: LiveProcess, idleTimeoutMs: number = liveProcessIdleTimeoutMs.current): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.kill();
	}, idleTimeoutMs);

	timer.unref();

	liveProcesses.set(process, timer);
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcess(toolCallIds: string[], owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && hasSameIds(process.toolCallIds, toolCallIds)) return process;
	}

	return null;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}
