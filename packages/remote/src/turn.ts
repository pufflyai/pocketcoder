import type { WorkspaceResource, WorkspaceTurnResolver } from "@pstdio/pocketcoder-sdk";
import { WorkspaceTurnResolutionError } from "@pstdio/pocketcoder-sdk";
import { DIRECT_MODE_ATTACHMENT_ERROR, type TurnAttachmentBatch } from "./attachments";
import { RemoteAgentClient } from "./client";
import type { ControlPlaneClient } from "./control-plane";
import { RemoteRequestError } from "./remote-request-error";
import { relayTarget, type SessionTarget } from "./session-target";

export type RemoteTurnResolver = Pick<WorkspaceTurnResolver, "resolve">;

export interface ExecuteRemoteTurnOptions {
  target: SessionTarget;
  controlPlane?: ControlPlaneClient;
  resolver?: RemoteTurnResolver;
  attachmentBatch: TurnAttachmentBatch;
  prompt: string;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: string) => void;
  fetch?: typeof fetch;
}

export interface RemoteTurnResult {
  text: string;
  workspaceId: string | undefined;
  workspace: WorkspaceResource | undefined;
}

function isRetryableTerminal(error: unknown): error is RemoteRequestError {
  return (
    error instanceof RemoteRequestError &&
    error.code === "workspace.terminal" &&
    !error.promptAccepted
  );
}

async function directTurn(options: ExecuteRemoteTurnOptions): Promise<RemoteTurnResult> {
  if (options.attachmentBatch.hasFiles) throw new Error(DIRECT_MODE_ATTACHMENT_ERROR);
  if (options.target.mode !== "direct") throw new Error("direct turn requires a direct target");
  const client = new RemoteAgentClient(
    { serviceUrl: options.target.serviceUrl, key: options.target.key },
    options.fetch,
  );
  const text = await client.send(options.prompt, options.signal, [], options.onSnapshot, () =>
    options.attachmentBatch.commit(),
  );
  return { text, workspaceId: undefined, workspace: undefined };
}

export async function executeRemoteTurn(
  options: ExecuteRemoteTurnOptions,
): Promise<RemoteTurnResult> {
  if (options.target.mode === "unset") {
    throw new Error("no workspace attached; run /workspace or /workspace-create first");
  }
  if (options.target.mode === "direct") return await directTurn(options);
  if (!options.controlPlane && options.attachmentBatch.hasFiles) {
    throw new Error(DIRECT_MODE_ATTACHMENT_ERROR);
  }

  let sourceWorkspaceId = options.target.workspaceId;
  for (let generationAttempt = 0; generationAttempt < 2; generationAttempt += 1) {
    let workspace: WorkspaceResource | undefined;
    if (options.resolver) {
      const resolved = await options.resolver.resolve(sourceWorkspaceId, {
        signal: options.signal,
      });
      workspace = resolved.workspace;
    }
    const workspaceId = workspace?.id ?? sourceWorkspaceId;
    const target = relayTarget(options.target.baseUrl, options.target.key, workspaceId);

    try {
      const attachmentIds = options.controlPlane
        ? await options.attachmentBatch.upload(options.controlPlane, workspaceId)
        : [];
      const client = new RemoteAgentClient(
        { serviceUrl: target.serviceUrl, key: target.key },
        options.fetch,
      );
      const text = await client.send(
        options.prompt,
        options.signal,
        attachmentIds,
        options.onSnapshot,
        () => options.attachmentBatch.commit(),
      );
      return { text, workspaceId, workspace };
    } catch (error) {
      if (!isRetryableTerminal(error) || generationAttempt === 1) throw error;
      if (!options.resolver) {
        throw new WorkspaceTurnResolutionError("resume_handler_missing", error);
      }
      sourceWorkspaceId = workspaceId;
    }
  }
  throw new Error("remote turn retry invariant failed");
}
