import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkspaceTurnResolver } from "@pstdio/pocketcoder-sdk";
import { captureTurnAttachmentBatch, registerAttachCommand, userTextOf } from "./attachments";
import { registerWorkspaceCommands } from "./commands";
import { ControlPlaneClient } from "./control-plane";
import { replayHistory } from "./history";
import { LiveSession } from "./live-session";
import { registerConversationRenderers } from "./renderers";
import { emitRemoteResponse } from "./response-stream";
import {
  relayTarget,
  type SessionTarget,
  TargetRef,
  targetFromEnvironment,
} from "./session-target";
import { STATUS_KEY, StatusPoller } from "./status";
import { executeRemoteTurn } from "./turn";

const PROVIDER = "pocketcoder-agentapi";
const MODEL = "remote-agent";

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
  controlPlane: ControlPlaneClient | undefined,
  resolver: WorkspaceTurnResolver | undefined,
  attachmentQueue: string[],
  model: Model<Api>,
  context: Context,
  signal?: AbortSignal,
  onOutputStart?: () => void,
  onResolved?: (
    source: SessionTarget,
    workspace: Parameters<LiveSession["applyResolved"]>[2],
  ) => Promise<void>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const source = targets.current;
  const attachmentBatch = captureTurnAttachmentBatch(context, attachmentQueue);
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
      await emitRemoteResponse(
        stream,
        output,
        async (onSnapshot) => {
          const result = await executeRemoteTurn({
            target: source,
            controlPlane,
            resolver,
            attachmentBatch,
            prompt: userTextOf(context),
            signal,
            onSnapshot,
          });
          if (result.workspace) await onResolved?.(source, result.workspace);
          return result.text;
        },
        onOutputStart,
      );
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

export interface RemoteExtensionOptions {
  resolver?: WorkspaceTurnResolver;
}

async function pickInitialWorkspace(
  controlPlane: ControlPlaneClient,
  targets: TargetRef,
  context: ExtensionContext,
): Promise<void> {
  const target = targets.current;
  if (target.mode !== "unset" || !context.hasUI) return;
  const workspaces = (await controlPlane.workspaces.list({ state: "ready" })).items;
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

export function createRemoteExtension(options: RemoteExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const targets = new TargetRef(targetFromEnvironment());
    const initial = targets.current;
    const controlPlane =
      initial.mode === "direct"
        ? undefined
        : new ControlPlaneClient({ baseUrl: initial.baseUrl, key: initial.key });
    const attachmentQueue: string[] = [];
    const liveSession = controlPlane
      ? new LiveSession(targets, (workspace, ui) => new StatusPoller(controlPlane, workspace, ui))
      : undefined;
    let activeContext: ExtensionContext | undefined;

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
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 100_000,
        },
      ],
      streamSimple: (model, context, streamOptions) => {
        const sessionIdentity = liveSession?.identity;
        return remoteStream(
          targets,
          controlPlane,
          options.resolver,
          attachmentQueue,
          model,
          context,
          streamOptions?.signal,
          () => activeContext?.ui.setWorkingVisible(false),
          async (source, workspace) => {
            await liveSession?.applyResolved(sessionIdentity, source, workspace);
          },
        );
      },
    });

    registerConversationRenderers(pi);
    registerAttachCommand(pi, { targets, queue: attachmentQueue });
    if (controlPlane) registerWorkspaceCommands(pi, { targets, controlPlane });

    pi.on("session_start", async (_event, context) => {
      activeContext = context;
      pi.setActiveTools([]);
      const sessionIdentity = await liveSession?.activate(context);

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
      if (!controlPlane || sessionIdentity === undefined) return;
      try {
        const workspace = await controlPlane.workspaces.get(target.workspaceId);
        await replayHistory(pi, controlPlane, target.workspaceId);
        liveSession?.attachPoller(sessionIdentity, workspace);
      } catch (error) {
        context.ui.notify(
          `could not load workspace history: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    });

    pi.on("turn_start", async () => liveSession?.pause());
    pi.on("turn_end", async (_event, context) => {
      context.ui.setWorkingVisible(true);
      liveSession?.resume();
    });
    pi.on("session_shutdown", async () => {
      activeContext = undefined;
      await liveSession?.shutdown();
    });
  };
}

export default createRemoteExtension();
