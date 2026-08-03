import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteAgentClient } from "./client";
import { registerWorkspaceCommands } from "./commands";
import { ControlPlaneClient } from "./control-plane";
import { replayHistory } from "./history";
import { registerConversationRenderers } from "./renderers";
import { relayTarget, TargetRef, targetFromEnvironment } from "./session-target";
import { STATUS_KEY, StatusPoller } from "./status";

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
	targets: TargetRef,
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
			const target = targets.current;
			if (target.mode === "unset") {
				throw new Error("no workspace attached; run /workspace or /workspace-create first");
			}
			const client = new RemoteAgentClient({ serviceUrl: target.serviceUrl, key: target.key });
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

async function pickInitialWorkspace(
	controlPlane: ControlPlaneClient,
	targets: TargetRef,
	context: ExtensionContext,
): Promise<void> {
	const target = targets.current;
	if (target.mode !== "unset" || !context.hasUI) return;
	const workspaces = await controlPlane.listWorkspaces({ state: "ready" });
	if (workspaces.length === 0) {
		context.ui.notify("no ready workspaces; run /workspace-create", "warning");
		return;
	}
	const labels = workspaces.map(
		(workspace) =>
			`${workspace.external_id} · ${workspace.template.name} · ${workspace.id.slice(0, 8)}`,
	);
	const selection = await context.ui.select("Attach to workspace", labels);
	if (selection === undefined) {
		context.ui.notify("no workspace attached; run /workspace to attach", "warning");
		return;
	}
	const workspace = workspaces[labels.indexOf(selection)];
	if (workspace) targets.set(relayTarget(target.baseUrl, target.key, workspace.id));
}

export default function (pi: ExtensionAPI): void {
	const targets = new TargetRef(targetFromEnvironment());
	const initial = targets.current;
	const controlPlane =
		initial.mode === "direct"
			? undefined
			: new ControlPlaneClient({ baseUrl: initial.baseUrl, key: initial.key });
	let poller: StatusPoller | undefined;

	pi.registerProvider(PROVIDER, {
		name: "PocketCoder remote agent",
		baseUrl: initial.mode === "direct" ? initial.serviceUrl : initial.baseUrl,
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
			remoteStream(targets, model, context, options?.signal),
	});

	registerConversationRenderers(pi);
	if (controlPlane) registerWorkspaceCommands(pi, { targets, controlPlane });

	pi.on("session_start", async (_event, context) => {
		pi.setActiveTools([]);
		await poller?.stop();
		poller = undefined;

		if (controlPlane) await pickInitialWorkspace(controlPlane, targets, context);
		const target = targets.current;
		if (target.mode === "direct") {
			context.ui.setStatus(STATUS_KEY, "direct agentapi");
			return;
		}
		if (target.mode === "unset") {
			context.ui.setStatus(STATUS_KEY, "no workspace");
			return;
		}
		context.ui.setStatus(STATUS_KEY, `ws ${target.workspaceId.slice(0, 8)}`);
		if (!controlPlane) return;
		try {
			const workspace = await controlPlane.getWorkspace(target.workspaceId);
			await replayHistory(pi, controlPlane, target.workspaceId);
			poller = new StatusPoller(controlPlane, workspace, context.ui);
			poller.start();
		} catch (error) {
			context.ui.notify(
				`could not load workspace history: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.on("turn_start", async () => poller?.pause());
	pi.on("turn_end", async () => poller?.resume());
	pi.on("session_shutdown", async () => {
		await poller?.stop();
		poller = undefined;
	});
}
