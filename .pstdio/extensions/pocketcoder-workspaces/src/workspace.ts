import {
  defineWorkspaceType,
  type JsonObject,
  params,
  type WorkspaceProviderRef,
  type WorkspaceProviderResult,
  type WorkspaceProviderState,
} from "@pstdio/sdk/extensions";
import { type ConnectionContext, isTerminal, type RemoteWorkspace, request, workspacePath } from "./connection";

export const workspaceParams = {
  repository: params.text({ label: "Repository alias (optional)" }),
  revision: params.text({ label: "Branch, tag, or commit (with repository)" }),
};

export async function launchInput(settings: Record<string, unknown>, input: Record<string, unknown>) {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(workspaceParams, key)) throw new Error(`Unsupported workspace parameter: ${key}`);
  const name = settings.templateName;
  const version = settings.templateVersion;
  if (typeof name !== "string" || !name.trim())
    throw new Error("Configure the workspace template in extension settings.");
  if (typeof version !== "string" || !version.trim())
    throw new Error("Configure an immutable template version in extension settings.");
  const { repository, revision } = input;
  if ((repository === undefined || repository === "") && (revision === undefined || revision === ""))
    return { template: { name, version } };
  if (typeof repository !== "string" || !repository.trim() || typeof revision !== "string" || !revision.trim())
    throw new Error("Provide both a repository alias and a revision, or leave both unset.");
  return { template: { name, version }, source: { kind: "git" as const, repository, revision } };
}

export function remoteRef(ref: WorkspaceProviderRef) {
  if (
    ref.version !== 1 ||
    typeof ref.data.remoteId !== "string" ||
    !ref.data.remoteId ||
    typeof ref.data.workspaceId !== "string" ||
    !ref.data.workspaceId
  )
    throw new Error("Invalid PocketCoder workspace reference.");
  return { remoteId: ref.data.remoteId, workspaceId: ref.data.workspaceId };
}

export async function readWorkspace(ctx: ConnectionContext, ref: ReturnType<typeof remoteRef>, signal?: AbortSignal) {
  const workspace = await request<RemoteWorkspace>(ctx, { method: "GET", path: workspacePath(ref.remoteId), signal });
  if (workspace.id !== ref.remoteId || workspace.external_id !== ref.workspaceId)
    throw new Error("The controller returned a workspace owned by another Prompt Studio workspace.");
  return workspace;
}

export function projectWorkspace(extensionId: string, workspace: RemoteWorkspace) {
  const states: Record<RemoteWorkspace["state"], WorkspaceProviderState> = {
    queued: "provisioning",
    provisioning: "provisioning",
    connected: "provisioning",
    ready: "ready",
    preserving: "provisioning",
    terminating: "deleting",
    succeeded: "archived",
    preserved: "archived",
    canceled: "cancelled",
    expired: "failed",
    failed: "failed",
  };
  const providerRef = { version: 1, data: { remoteId: workspace.id, workspaceId: workspace.external_id } };
  const state = states[workspace.state];
  return {
    providerRef,
    state,
    executionKind: "remote",
    executionTarget: { kind: "remote", providerId: `${extensionId}.workspace-type.remote`, providerRef },
    displayPath: `PocketCoder / ${workspace.id}`,
    capabilities: { files: "none", diff: false, merge: false, rebase: false, archive: false, delete: true },
    ...(state === "failed"
      ? {
          error: {
            code: workspace.reason_code ?? workspace.state,
            message: workspace.failure?.log_tail || `Workspace ${workspace.state}.`,
            retryable: false,
          },
        }
      : {}),
  } satisfies WorkspaceProviderResult;
}

export const remoteWorkspace = defineWorkspaceType({
  id: "remote",
  label: "PocketCoder workspace",
  icon: "cloud",
  params: workspaceParams,
  async create(ctx, input) {
    const body = await launchInput(await ctx.settings.all(), input.params);
    const payload: JsonObject = { template: body.template, external_id: input.workspaceId };
    if (body.source) payload.source = body.source;
    const workspace = await request<RemoteWorkspace>(ctx, {
      method: "POST",
      path: "/v1/workspaces",
      headers: { "Idempotency-Key": input.operationId },
      body: payload,
      signal: input.signal,
    });
    if (workspace.external_id !== input.workspaceId) throw new Error("Workspace ownership did not match the launch.");
    return projectWorkspace(ctx.extensionId, workspace);
  },
  async resolve(ctx, input) {
    return projectWorkspace(ctx.extensionId, await readWorkspace(ctx, remoteRef(input.providerRef)));
  },
  async cancel(ctx, input) {
    const ref = remoteRef(input.providerRef);
    const workspace = await readWorkspace(ctx, ref);
    if (isTerminal(workspace)) return projectWorkspace(ctx.extensionId, workspace);
    return projectWorkspace(
      ctx.extensionId,
      await request<RemoteWorkspace>(ctx, {
        method: "POST",
        path: `${workspacePath(ref.remoteId)}/cancel`,
      }),
    );
  },
  async delete(ctx, input) {
    const ref = remoteRef(input.providerRef);
    let workspace = await readWorkspace(ctx, ref);
    if (!isTerminal(workspace))
      workspace = await request<RemoteWorkspace>(ctx, {
        method: "POST",
        path: `${workspacePath(ref.remoteId)}/cancel`,
      });
    while (!isTerminal(workspace)) {
      const change = await request<{ workspace: RemoteWorkspace }>(ctx, {
        method: "GET",
        path: `${workspacePath(ref.remoteId)}/changes?after=${workspace.change_cursor}&wait=30`,
        timeoutMs: 35_000,
      });
      workspace = change.workspace;
    }
  },
});
