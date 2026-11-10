import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus } from "../../core/contracts/antigravity.ts";
import { getAgyBinary } from "./binary.ts";

export type RunAgyCommand = (binary: string, args: string[], timeoutMs: number) => Promise<string>;

export type AgyModelInfo = { id: string; name: string };

/** No shell and no credential-file inspection. `models` asks the CLI's own service. */
export const runAgyCommand: RunAgyCommand = (binary, args, timeoutMs) => new Promise((resolve, reject) => {
	execFile(binary, args, {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 65_536,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `agy models` prints one `id<TAB>display name` row per model (progress text goes to stderr). */
export function parseAgyModels(output: string): AgyModelInfo[] {
	const models: AgyModelInfo[] = [];
	for (const line of output.split(/\r?\n/)) {
		const [id, ...rest] = line.split("\t");
		const name = rest.join(" ").trim();
		if (!id || !MODEL_ID.test(id.trim()) || !name || models.some((model) => model.id === id.trim())) continue;
		models.push({ id: id.trim(), name: name.slice(0, 120) });
	}
	return models;
}

export async function listAgyModels(findBinary: () => string | null = getAgyBinary, run: RunAgyCommand = runAgyCommand): Promise<AgyModelInfo[] | null> {
	const binary = findBinary();
	if (!binary) return null;
	try {
		const models = parseAgyModels(await run(binary, ["models"], 30_000));
		return models.length > 0 ? models : null;
	} catch {
		return null;
	}
}

export async function inspectAgyInstallation(
	findBinary: () => string | null = getAgyBinary,
	run: RunAgyCommand = runAgyCommand,
): Promise<Omit<AntigravityStatus, "modelCount">> {
	const base = { version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await run(binary, ["--version"], 5_000);
		// Expose only a version, never arbitrary CLI output or an absolute path.
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim());
		if (!match) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		if (!parts.every(Number.isSafeInteger)) return { ...base, state: "version-unchecked" };
		const minimum = ANTIGRAVITY_MINIMUM_VERSION.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "update-required" };
	} catch {
		return { ...base, state: "version-unchecked" };
	}
}
