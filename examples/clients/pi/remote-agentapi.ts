import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RemoteAgentClient, serviceUrlFromEnvironment } from "./client";

const PROVIDER = "pocketcoder-agentapi";
const MODEL = "remote-agent";

function userText(context: Context): string {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	if (message?.role !== "user") throw new Error("local Pi did not provide a user message");
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function remoteStream(
	client: RemoteAgentClient,
	model: Model<Api>,
	context: Context,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	void (async () => {
		stream.push({ type: "start", partial: output });
		try {
			const reply = await client.send(userText(context), signal);
			output.content.push({ type: "text", text: reply });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		} catch (error) {
			output.stopReason = signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI): void {
	const { serviceUrl, key } = serviceUrlFromEnvironment();
	const client = new RemoteAgentClient({ serviceUrl, key });

	pi.registerProvider(PROVIDER, {
		name: "PocketCoder remote AgentAPI",
		baseUrl: serviceUrl,
		apiKey: "local-ui",
		api: "openai-completions",
		models: [
			{
				id: MODEL,
				name: "PocketCoder remote agent",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 100_000,
			},
		],
		streamSimple: (model, context, options) =>
			remoteStream(client, model, context, options?.signal),
	});

	pi.on("session_start", async (_event, context) => {
		pi.setActiveTools([]);
		context.ui.setStatus(
			"pocketcoder",
			`remote ${process.env.POCKETCODER_WORKSPACE_ID ?? "agent"}`,
		);
	});
}
