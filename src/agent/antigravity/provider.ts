import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";
import type { AgyModelInfo } from "./installation.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

/** One pi entry per CLI-listed model. agy encodes thinking depth in its model ids
 * (for example gemini-3.8-flash-low/high), so LearnHarness offers no separate level. */
export function toAntigravityModel(info: AgyModelInfo): Model<Api> {
	return {
		id: info.id,
		name: info.name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		// Pi-required placeholders, not prices: the CLI's account determines charges.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	};
}

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>, models: readonly AgyModelInfo[]): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: models.map(toAntigravityModel),
		api: { stream: streamSimple, streamSimple },
	});
}
