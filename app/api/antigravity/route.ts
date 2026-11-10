import { antigravityInstallationResponse } from "@/src/server";

/** Installation/version plus the CLI's model list; never reads auth status or makes a model request. */
export async function GET(request: Request) {
	return antigravityInstallationResponse(request);
}
