export function serviceUrlFromEnvironment(env: NodeJS.ProcessEnv = process.env): {
	serviceUrl: string;
	key: string;
} {
	const directUrl = env.POCKETCODER_AGENTAPI_URL;
	const key = env.POCKETCODER_KEY;
	if (!key) throw new Error("POCKETCODER_KEY is required");
	if (directUrl) return { serviceUrl: directUrl, key };

	const baseUrl = (env.POCKETCODER_URL ?? "http://127.0.0.1:7080").replace(/\/$/, "");
	const workspaceId = env.POCKETCODER_WORKSPACE_ID;
	if (!workspaceId) {
		throw new Error("POCKETCODER_WORKSPACE_ID or POCKETCODER_AGENTAPI_URL is required");
	}
	return {
		serviceUrl: `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent`,
		key,
	};
}
