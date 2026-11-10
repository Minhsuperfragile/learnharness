import { inspectAgyInstallation } from "../agent/antigravity/installation.ts";
import type { AntigravityStatus } from "../core/contracts/antigravity.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { antigravityEnabled, refreshAntigravityModels } from "./antigravity-config.ts";

/** The Settings status seam: version check, then the CLI's model list. Initialize
 * provenance before any child env is copied. No authentication-status command exists. */
export async function antigravityInstallationStatus(): Promise<AntigravityStatus> {
	initAuthEnv();
	const status = await inspectAgyInstallation();
	const modelCount = status.state === "meets-minimum" ? await refreshAntigravityModels() : null;
	return { ...status, modelCount };
}

/** Same-origin browser intent, not user authentication. No CORS grants. */
export async function antigravityInstallationResponse(
	request: Request,
	inspect = antigravityInstallationStatus,
	enabled = antigravityEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-antigravity") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: "Antigravity CLI is disabled." }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}
