import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import { getAgyBinary } from "../agent/antigravity/binary.ts";
import { listAgyModels, parseAgyModels, type AgyModelInfo } from "../agent/antigravity/installation.ts";
import { setAntigravityModels } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

/** The last model list the CLI reported, kept beside settings so saved slots
 * resolve after a restart without asking the CLI first. Non-secret. */
const MODELS_CACHE_FILE = path.join(path.dirname(SETTINGS_FILE), "antigravity-models.json");

/** Fresh admission state, not a process-wide cache (same discipline as Claude Code). */
export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function antigravityAvailable(): boolean {
	return antigravityEnabled() && getAgyBinary() !== null;
}

function readCachedModels(): AgyModelInfo[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		// Re-validate through the same parser the CLI output uses.
		return parseAgyModels(parsed.flatMap((entry) => typeof entry?.id === "string" && typeof entry?.name === "string" ? [`${entry.id}\t${entry.name}`] : []).join("\n"));
	} catch {
		return [];
	}
}

let cachedModelCount: number | null = null;

export function loadAntigravityModels(): void {
	const models = readCachedModels();
	cachedModelCount = models.length > 0 ? models.length : null;
	setAntigravityModels(models);
}

/** Ask the CLI for its current list. A failed read keeps the previous list. */
export async function refreshAntigravityModels(list = listAgyModels): Promise<number | null> {
	const models = await list();
	if (!models) return cachedModelCount;
	fs.mkdirSync(path.dirname(MODELS_CACHE_FILE), { recursive: true });
	writeFileAtomicSync(MODELS_CACHE_FILE, JSON.stringify(models, null, "\t"), { allowInPlaceFallback: true });
	cachedModelCount = models.length;
	setAntigravityModels(models);
	return models.length;
}

loadAntigravityModels();
