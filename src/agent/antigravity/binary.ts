import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

/** PATH first, then the locations the official installer uses. Direct spawn uses no shell,
 * so only a directly runnable agy.exe counts on Windows. */
export function resolveAgyBinary({ env, platform, homeDir, cwd = process.cwd(), isExecutable }: BinaryLookup): string | null {
	const windows = platform === "win32";
	const paths = windows ? path.win32 : path.posix;
	const name = windows ? "agy.exe" : "agy";
	const knownDirs = windows
		? [
			paths.join(env.LOCALAPPDATA ?? paths.join(homeDir, "AppData", "Local"), "agy", "bin"),
			paths.join(homeDir, ".local", "bin"),
		]
		: [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".agy", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
		];
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);

	for (const dir of [...pathDirs, ...knownDirs]) {
		// Same absolute identity for the version probe, model listing, and lesson processes.
		const candidate = paths.resolve(cwd, dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getAgyBinary(): string | null {
	return resolveAgyBinary({ env: process.env, platform: process.platform, homeDir: os.homedir(), isExecutable: isExecutableFile });
}
