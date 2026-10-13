import {
  type CommandContext,
  defineCommand,
  eventRef,
  params,
  workbenchPages,
  workbenchResourceKinds,
} from "@pstdio/sdk/extensions";
import { readWorkspace, remoteRef, workspaceParams } from "./workspace";

export const changed = eventRef({ extensionId: "pocketcoder.pocketcoder-workspaces", id: "changed" });
export const createWorkspace = defineCommand({
  id: "launch",
  title: "Create PocketCoder workspace",
  cli: true,
  mutating: true,
  palette: [{ group: "PocketCoder Workspaces", label: "Create PocketCoder workspace" }],
  params: workspaceParams,
  async run(ctx, input) {
    const workspace = await ctx.workspaces.create({
      project_id: ctx.projectId,
      shorthand_base: "PC-WORKSPACE",
      provider_id: `${ctx.extensionId}.workspace-type.remote`,
      params: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== "")),
    });
    await ctx.events.emit(changed, {});
    return { workspaceId: workspace.id };
  },
});
const workspaceParam = { workspaceId: params.text({ label: "Workspace ID", resolvedFrom: "resource" }) };
async function selectedWorkspace(ctx: CommandContext, id?: string) {
  const workspaceId = id ?? (ctx.resource?.type === "workspace" ? ctx.resource.id : undefined);
  const workspace = workspaceId ? await ctx.workspaces.get(workspaceId) : null;
  if (workspace?.provider_id !== `${ctx.extensionId}.workspace-type.remote`)
    throw new Error("Choose a PocketCoder workspace from the Workspaces extension.");
  return workspace;
}
export const connectWorkspace = defineCommand({
  id: "connect",
  title: "Connect to workspace agent",
  cli: true,
  mutating: true,
  params: workspaceParam,
  async run(ctx, input) {
    const workspace = await selectedWorkspace(ctx, input.workspaceId);
    const resolved = await ctx.workspaces.resolve(workspace.id);
    if (!resolved.providerRef) throw new Error(`Workspace is ${resolved.state}. Wait until it is ready.`);
    const remote = await readWorkspace(ctx, remoteRef(resolved.providerRef));
    if (remote.state !== "ready") throw new Error(`Workspace is ${remote.state}. Wait until it is ready.`);
    const key = `workspace-session:${workspace.id}`;
    const id = await ctx.storage.get<string>(key);
    const existing = id ? await ctx.sessions.get(id) : null;
    const session =
      existing ??
      (await ctx.sessions.create({
        title: `PocketCoder: ${workspace.workspace_shorthand}`,
        workspaceId: workspace.id,
        harness: { harnessId: `${ctx.extensionId}.harness.agent` },
      }));
    await ctx.storage.set(key, session.id);
    ctx.navigation.open({
      kind: "page",
      page: workbenchPages.session,
      resource: {
        type: workbenchResourceKinds.session.id,
        extensionId: "pstdio",
        projectId: ctx.projectId,
        id: session.id,
        label: session.title,
      },
    });
    return { workspaceId: workspace.id, sessionId: session.id };
  },
});
export const deleteWorkspace = defineCommand({
  id: "delete",
  title: "Delete PocketCoder workspace",
  cli: true,
  mutating: true,
  params: workspaceParam,
  async run(ctx, input) {
    const workspace = await selectedWorkspace(ctx, input.workspaceId);
    await ctx.workspaces.delete(workspace.id);
    await ctx.events.emit(changed, {});
    return { workspaceId: workspace.id };
  },
});
export const refresh = defineCommand({
  id: "refresh",
  title: "Refresh PocketCoder workspaces",
  cli: true,
  async run(ctx) {
    await ctx.events.emit(changed, {});
    return {};
  },
});
