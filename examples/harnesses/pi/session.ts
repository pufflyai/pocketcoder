import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CodingSession } from "./app";

function required(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => contentText(item))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") return record.text;
	return contentText(record.content);
}

export async function createPiSession(
	env: Record<string, string | undefined> = process.env,
): Promise<CodingSession> {
	const baseUrl = required(env, "PI_GATEWAY_URL");
	const modelId = required(env, "PI_GATEWAY_MODEL");
	const provider = env.PI_GATEWAY_PROVIDER ?? "pocketcoder-gateway";
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider(provider, {
		name: "PocketCoder model gateway",
		baseUrl,
		api: "openai-completions",
		apiKey: "pocketcoder-local-gateway",
		authHeader: env.PI_GATEWAY_AUTH_HEADER === "true",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: Number(env.PI_GATEWAY_CONTEXT_WINDOW ?? 128_000),
				maxTokens: Number(env.PI_GATEWAY_MAX_TOKENS ?? 16_384),
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
		],
	});
	const model = modelRuntime.getModel(provider, modelId);
	if (!model) throw new Error(`Pi did not register model ${provider}/${modelId}`);
	const { session } = await createAgentSession({
		cwd: env.PI_WORKSPACE_DIR ?? "/workspace",
		agentDir: env.PI_CODING_AGENT_DIR ?? "/home/agent/.pi/agent",
		modelRuntime,
		model,
		sessionManager: SessionManager.inMemory(),
	});

	return {
		async prompt(content: string): Promise<string> {
			await session.prompt(content);
			const assistant = [...session.messages]
				.reverse()
				.find((message) => message.role === "assistant");
			const text = contentText(assistant?.content);
			if (!text) throw new Error("Pi completed without an assistant text message");
			return text;
		},
		dispose(): void {
			session.dispose();
		},
	};
}
