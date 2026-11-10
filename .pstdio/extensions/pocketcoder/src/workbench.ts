import {
  defineNavigationItem,
  definePage,
  type PlacementTabPresentation,
  workbenchModes,
} from "@pstdio/sdk/extensions";
import { startInstance, stopInstance } from "./commands";
import { removeInstance } from "./instance-removal";
import { instancesFor } from "./instances";
import { labCommands } from "./lab-commands";
import { instancesPageRef } from "./lab-navigation";
import { instancesView, machinesView, templatesView } from "./native-tables";
import { changed, instanceKind } from "./resources";

const instanceTab = (label: string): PlacementTabPresentation => ({
  refreshEvents: [changed],
  async query(ctx, { renderer }) {
    const instances = await instancesFor(ctx.projectId).list();
    const current = renderer.resource?.id;
    return {
      label,
      menu: [
        {
          id: "instances",
          label: "PocketCoder instances",
          rows: instances
            .filter((instance) => instance.state === "running" || instance.id === current)
            .sort((a, b) => Number(b.state === "running") - Number(a.state === "running"))
            .map((instance) => ({
              id: instance.id,
              label: instance.state === "running" ? instance.name : `${instance.name} (stopped)`,
              icon: "server",
              selected: instance.id === current,
              action: {
                kind: "command" as const,
                target: { command: labCommands["lab.select"].ref, params: { instance: instance.id } },
              },
            })),
        },
        {
          id: "manage",
          rows: [
            {
              id: "browse",
              label: "Manage instances",
              icon: "server",
              action: { kind: "page" as const, page: instancesPageRef },
            },
            ...(current
              ? [
                  {
                    id: "start",
                    label: "Start instance",
                    icon: "play",
                    action: {
                      kind: "command" as const,
                      target: { command: startInstance.ref, params: { instanceId: current } },
                    },
                  },
                  {
                    id: "stop",
                    label: "Stop instance",
                    icon: "square",
                    action: {
                      kind: "command" as const,
                      target: { command: stopInstance.ref, params: { instanceId: current } },
                    },
                  },
                  ...(instances.find((instance) => instance.id === current)?.state === "stopped"
                    ? [
                        {
                          id: "remove",
                          label: "Remove instance",
                          icon: "trash-2",
                          action: {
                            kind: "command" as const,
                            target: { command: removeInstance.ref, params: { instanceId: current } },
                          },
                        },
                      ]
                    : []),
                ]
              : []),
          ],
        },
      ],
    };
  },
});
export const instancesPage = definePage({
  id: "instances",
  title: "PocketCoder Lab",
  icon: "server",
  path: "pocketcoder",
  mode: workbenchModes.project,
  main: { kind: "view", presentation: "page", view: instancesView.ref, cardinality: "one" },
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
  main: { kind: "panels", landing: "machines" },
  slots: [
    {
      id: "templates",
      region: "main",
      order: 0,
      tab: instanceTab("Templates"),
      item: { kind: "view", view: templatesView.ref, presence: "open" },
    },
    {
      id: "machines",
      region: "main",
      order: 1,
      tab: instanceTab("Machines"),
      item: { kind: "view", view: machinesView.ref, presence: "open" },
    },
  ],
});
export const navigation = defineNavigationItem({
  id: "pocketcoder",
  label: "PocketCoder Lab",
  icon: "server",
  owner: workbenchModes.project,
  slot: "content",
  action: { kind: "page", page: instancesPage.ref, intent: "restore" },
});
