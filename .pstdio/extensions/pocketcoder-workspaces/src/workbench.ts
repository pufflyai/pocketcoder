import {
  defineNavigationItem,
  definePage,
  defineView,
  viewDataEvents,
  workbenchModes,
  workbenchPages,
} from "@pstdio/sdk/extensions";
import { changed, connectWorkspace, createWorkspace, deleteWorkspace, refresh } from "./commands";
import { projectWorkspace, readWorkspace, remoteRef } from "./workspace";

export const workspacesView = defineView({
  id: "workspaces",
  title: "PocketCoder Workspaces",
  icon: "cloud",
  body: {
    kind: "dataTable",
    refreshEvents: [changed, viewDataEvents.workspacesChanged, viewDataEvents.sessionsChanged],
    emptyTitle: "Create a remote workspace",
    emptyDescription:
      "Configure the PocketCoder connection and fixed template in this extension's settings, then create a workspace.",
    toolbarActions: [
      {
        id: "create",
        label: "Create workspace",
        icon: "plus",
        presentation: "primary",
        command: createWorkspace.ref,
        input: createWorkspace.params,
        submitLabel: "Create workspace",
      },
      { id: "refresh", label: "Refresh", icon: "refresh-cw", command: refresh.ref },
    ],
    columns: [
      { id: "name", label: "Workspace" },
      { id: "state", label: "State" },
      { id: "error", label: "Error" },
    ],
    rowActions: [
      { id: "connect", label: "Connect to agent", icon: "messages-square", command: connectWorkspace.ref },
      { id: "delete", label: "Delete workspace", icon: "trash-2", destructive: true, command: deleteWorkspace.ref },
    ],
    async query(ctx) {
      const workspaces = (await ctx.workspaces.list()).filter(
        (workspace) => workspace.provider_id === `${ctx.extensionId}.workspace-type.remote`,
      );
      return {
        rows: await Promise.all(
          workspaces.map(async (workspace) => {
            let state: string = workspace.provider_state ?? "provisioning";
            let error = workspace.setup_error ?? "";
            try {
              const saved = await ctx.workspaces.resolve(workspace.id);
              if (saved.providerRef) {
                const live = projectWorkspace(ctx.extensionId, await readWorkspace(ctx, remoteRef(saved.providerRef)));
                state = live.state;
                error = live.error?.message ?? "";
              }
            } catch (failure) {
              state = "unreachable";
              error = failure instanceof Error ? failure.message : "Could not reach the controller.";
            }
            return {
              id: workspace.id,
              resource: {
                type: "workspace",
                extensionId: "pstdio",
                projectId: ctx.projectId,
                id: workspace.id,
                label: workspace.workspace_shorthand,
              },
              values: { name: workspace.workspace_shorthand ?? workspace.id, state, error },
            };
          }),
        ),
      };
    },
  },
});
export const workspacesPage = definePage({
  id: "remote-workspaces",
  title: "PocketCoder Workspaces",
  icon: "cloud",
  path: "pocketcoder-workspaces",
  mode: workbenchModes.project,
  parent: workbenchPages.start,
  main: { kind: "view", view: workspacesView.ref, cardinality: "one" },
  slots: [],
});
export const navigation = defineNavigationItem({
  id: "workspaces",
  label: "PocketCoder Workspaces",
  icon: "cloud",
  owner: workbenchModes.project,
  slot: "content",
  action: { kind: "page", page: workspacesPage.ref },
});
