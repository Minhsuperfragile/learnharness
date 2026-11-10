import { CLAUDE_CODE_PROVIDER } from "./claude-code.ts";

export const ANTIGRAVITY_PROVIDER = "antigravity";

/** Installation/version plus the CLI-reported model count. Never an authentication, quota, or billing verdict. */
export interface AntigravityStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
	/** Models the CLI listed at the last successful refresh; null when the list could not be read. */
	modelCount: number | null;
}

// 1.5.3 is the first version verified against: ACP stdio, http MCP servers in
// session/new, and _meta.antigravity.systemPrompt.append. Not an official contract.
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.3";

/** External CLI providers own authentication, routing, and billing; LearnHarness prices none of them. */
export function isExternalCliProvider(provider: string): boolean {
	return provider === CLAUDE_CODE_PROVIDER || provider === ANTIGRAVITY_PROVIDER;
}
