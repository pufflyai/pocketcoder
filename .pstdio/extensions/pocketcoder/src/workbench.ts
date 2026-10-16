import {
  defineNavigationItem,
  definePage,
  defineView,
  viewDataEvents,
  workbenchModes,
  workbenchPages,
  workbenchResourceKinds,
} from "@pstdio/sdk/extensions";
import {
  connectMachine,
  deleteMachine,
  importTemplates,
  launchInstance,
  launchMachine,
  refresh,
  startInstance,
  stopInstance,
} from "./commands";
import { instancesFor } from "./instances";
import { changed, instanceKind } from "./resources";

const refreshAction = { id: "refresh", label: "Refresh", icon: "refresh-cw", command: refresh.ref };
export const instancesView = defineView({
  id: "instances",
  title: "PocketCoder instances",
  icon: "server",
  body: {
    kind: "dataTable",
    refreshEvents: [changed],
    emptyTitle: "Launch a PocketCoder instance",
    emptyDescription:
      "An instance is a local PocketCoder 1.0 server. Launch one, import agent templates, then launch machines.",
    toolbarActions: [
      {
        id: "launch",
        label: "Launch instance",
        icon: "plus",
        presentation: "primary",
        command: launchInstance.ref,
        input: launchInstance.params,
        submitLabel: "Launch instance",
      },
      refreshAction,
    ],
    columns: [
      { id: "name", label: "Instance" },
      { id: "state", label: "State" },
      { id: "url", label: "Operator API" },
      { id: "id", label: "Instance ID" },
    ],
    rowActions: [
      { id: "start", label: "Start / renew key", icon: "play", command: startInstance.ref },
      { id: "stop", label: "Stop instance", icon: "square", command: stopInstance.ref },
    ],
    async query(ctx) {
      return {
        rows: (await instancesFor(ctx.projectId).list()).map((instance) => ({
          id: instance.id,
          resource: { type: instanceKind.id, id: instance.id, label: instance.name },
          values: { name: instance.name, state: instance.state, url: instance.url, id: instance.id },
        })),
      };
    },
    onRowActivate(ctx, { row }) {
      ctx.navigation.open({ kind: "page", page: instancePage.ref, resource: row.resource });
    },
  },
});

export const machinesView = defineView({
  id: "machines",
  title: "Agent machines",
  icon: "bot",
  body: {
    kind: "dataTable",
    refreshEvents: [changed, viewDataEvents.workspacesChanged, viewDataEvents.sessionsChanged],
    emptyTitle: "Launch an agent machine",
    emptyDescription:
      "Import prepared agent templates into this instance, then launch a machine. Connect when it is ready.",
    toolbarActions: [
      {
        id: "launch",
        label: "Launch machine",
        icon: "plus",
        presentation: "primary",
        command: launchMachine.ref,
        input: launchMachine.params,
        submitLabel: "Launch machine",
      },
      {
        id: "import",
        label: "Import templates",
        icon: "package",
        command: importTemplates.ref,
        input: importTemplates.params,
        submitLabel: "Import templates",
      },
      refreshAction,
    ],
    columns: [
      { id: "name", label: "Machine" },
      { id: "state", label: "State" },
      { id: "session", label: "Agent session" },
      { id: "error", label: "Error" },
    ],
    rowActions: [
      { id: "connect", label: "Connect to agent", icon: "messages-square", command: connectMachine.ref },
      { id: "delete", label: "Delete machine", icon: "trash-2", destructive: true, command: deleteMachine.ref },
    ],
    async query(ctx, { renderer }) {
      const instanceId = renderer.resource?.id;
      const workspaces = (await ctx.workspaces.list()).filter(
        (workspace) =>
          workspace.provider_id === `${ctx.extensionId}.workspace-type.machine` &&
          workspace.anchors_json?.some((anchor) => anchor.id === instanceId),
      );
      return {
        rows: await Promise.all(
          workspaces.map(async (workspace) => {
            const sessionId = await ctx.storage.get<string>(`machine-session:${workspace.id}`);
            const session = sessionId ? await ctx.sessions.get(sessionId) : null;
            return {
              id: workspace.id,
              resource: {
                type: workbenchResourceKinds.workspace.id,
                extensionId: "pstdio",
                projectId: ctx.projectId,
                id: workspace.id,
                label: workspace.workspace_shorthand,
              },
              values: {
                name: workspace.workspace_shorthand ?? workspace.id,
                state: workspace.provider_state ?? "provisioning",
                session: session?.status ?? "Not connected",
                error: workspace.setup_error ?? "",
              },
            };
          }),
        ),
      };
    },
  },
});

export const instancesPage = definePage({
  id: "instances",
  title: "PocketCoder",
  icon: "server",
  path: "pocketcoder",
  mode: workbenchModes.project,
  parent: workbenchPages.start,
  main: { kind: "view", view: instancesView.ref, cardinality: "one" },
  slots: [],
});
export const instancePage = definePage({
  id: "instance",
  title: "PocketCoder instance",
  icon: "server",
  path: "pocketcoder-instance",
  mode: workbenchModes.project,
  parent: instancesPage.ref,
  resource: { kinds: [instanceKind.ref] },
  main: { kind: "view", view: machinesView.ref, cardinality: "one" },
  slots: [],
});
export const navigation = defineNavigationItem({
  id: "pocketcoder",
  label: "PocketCoder",
  icon: "server",
  owner: workbenchModes.project,
  slot: "content",
  action: { kind: "page", page: instancesPage.ref },
});
