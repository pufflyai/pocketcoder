import { defineView } from "@pstdio/sdk/extensions";
import { refresh, stopInstance } from "./commands";
import { launchInstance, startInstance } from "./instance-commands";
import { removeInstance } from "./instance-removal";
import { instancesFor } from "./instances";
import { labCommands } from "./lab-commands";
import type { LabTemplate } from "./lab-model";
import { machineStateLabel } from "./machine-status";
import { ensureMachineWatch } from "./machine-watch";
import type { ControllerMachine } from "./machines";
import { changed, instanceKind, machineKind } from "./resources";
import {
  connectMachineRow,
  deleteMachineRow,
  importSelectedTemplates,
  launchSelectedMachine,
  publishSelectedTemplate,
} from "./table-commands";
import { saveTemplate } from "./template-commands";

const refreshAction = { id: "refresh", label: "Refresh", icon: "refresh-cw", command: refresh.ref };
const launchInstanceAction = {
  id: "launch-instance",
  label: "Launch instance",
  icon: "plus",
  command: launchInstance.ref,
  input: launchInstance.params,
  submitLabel: "Launch instance",
};

export const instancesView = defineView({
  id: "instances",
  title: "Instances",
  icon: "server",
  body: {
    kind: "dataTable",
    refreshEvents: [changed],
    emptyTitle: "Launch a PocketCoder instance",
    emptyDescription: "Save a template, then launch an instance with the local executable.",
    toolbarActions: [
      launchInstanceAction,
      { id: "save", label: "Save template", icon: "file-plus", command: saveTemplate.ref, input: saveTemplate.params },
      refreshAction,
    ],
    columns: [
      { id: "name", label: "Instance" },
      { id: "state", label: "State" },
      { id: "connection", label: "Connection" },
      { id: "url", label: "Operator API" },
      { id: "error", label: "Error" },
    ],
    rowActions: [
      { id: "open", label: "Browse instance", icon: "server", command: labCommands["lab.select"].ref },
      { id: "start", label: "Start instance", icon: "play", command: startInstance.ref },
      { id: "stop", label: "Stop instance", icon: "square", command: stopInstance.ref },
      { id: "remove", label: "Remove instance", icon: "trash-2", destructive: true, command: removeInstance.ref },
    ],
    async query(ctx) {
      const instances = instancesFor(ctx.projectId);
      return {
        rows: await Promise.all(
          (await instances.list()).map(async (instance) => ({
            id: instance.id,
            resource: { type: instanceKind.id, id: instance.id, label: instance.name },
            values: {
              name: instance.name,
              state: instance.state,
              connection: await instances.connection(instance.id),
              url: instance.url,
              error: instance.error ?? "",
            },
          })),
        ),
      };
    },
    async onRowActivate(ctx, { row }) {
      await ctx.commands.execute(labCommands["lab.select"].ref, { params: { instance: row.id } });
    },
  },
});

export const templatesView = defineView({
  id: "templates",
  title: "Templates",
  icon: "package",
  body: {
    kind: "dataTable",
    refreshEvents: [changed],
    emptyTitle: "No published templates",
    emptyDescription: "Start the instance, then add a catalog template.",
    toolbarActions: [
      {
        id: "add",
        label: "Add template",
        icon: "plus",
        presentation: "primary",
        command: publishSelectedTemplate.ref,
        input: publishSelectedTemplate.params,
        submitLabel: "Add template",
      },
      {
        id: "import",
        label: "Import templates",
        icon: "package",
        command: importSelectedTemplates.ref,
        input: importSelectedTemplates.params,
        submitLabel: "Import templates",
      },
      {
        id: "save",
        label: "Save template",
        icon: "file-plus",
        command: saveTemplate.ref,
        input: saveTemplate.params,
        submitLabel: "Save template",
      },
      refreshAction,
    ],
    columns: [
      { id: "name", label: "Template" },
      { id: "version", label: "Version" },
      { id: "status", label: "Status" },
      { id: "description", label: "Description" },
    ],
    async query(ctx, { renderer }) {
      const id = renderer.resource?.id;
      if (!id) return { rows: [] };
      const instances = instancesFor(ctx.projectId);
      if ((await instances.get(id)).state !== "running") return { rows: [] };
      const templates = await instances.items<LabTemplate>(id, "/v1/templates");
      return {
        rows: templates.map((template) => ({
          id: `${template.name}@${template.version}`,
          values: {
            name: template.name,
            version: template.version,
            status: template.status,
            description: template.description ?? "",
          },
        })),
      };
    },
  },
});
export const machinesView = defineView({
  id: "machines",
  title: "Machines",
  icon: "bot",
  body: {
    kind: "dataTable",
    refreshEvents: [changed, "pocketcoder.pocketcoder.event.automation-run-changed"],
    emptyTitle: "No machines on this instance",
    emptyDescription: "Launch a machine from a published template, then connect when it is ready.",
    toolbarActions: [
      {
        id: "launch",
        label: "Launch machine",
        icon: "plus",
        presentation: "primary",
        command: launchSelectedMachine.ref,
        input: launchSelectedMachine.params,
        submitLabel: "Launch machine",
      },
      refreshAction,
    ],
    columns: [
      { id: "name", label: "Machine" },
      { id: "template", label: "Template" },
      { id: "state", label: "State" },
      { id: "error", label: "Error" },
    ],
    rowActions: [
      { id: "connect", label: "Connect to agent", icon: "messages-square", command: connectMachineRow.ref },
      { id: "delete", label: "Delete machine", icon: "trash-2", destructive: true, command: deleteMachineRow.ref },
    ],
    async query(ctx, { renderer }) {
      const id = renderer.resource?.id;
      if (!id) return { rows: [] };
      const instances = instancesFor(ctx.projectId);
      if ((await instances.get(id)).state !== "running") return { rows: [] };
      const dismissed = new Set((await ctx.storage.get<string[]>(`dismissed-machines:${id}`)) ?? []);
      const machines = await instances.items<ControllerMachine>(id, "/v1/workspaces");
      const watches = await Promise.allSettled(
        machines.filter((machine) => !dismissed.has(machine.id)).map((machine) => ensureMachineWatch(ctx, id, machine)),
      );
      for (const watch of watches)
        if (watch.status === "rejected") ctx.logger.warn(`Machine state watch failed: ${String(watch.reason)}`);
      return {
        rows: machines
          .filter((machine) => !dismissed.has(machine.id))
          .map((machine) => ({
            id: machine.id,
            resource: { type: machineKind.id, id: `${id}:${machine.id}`, label: machine.external_id },
            values: {
              name: machine.external_id,
              template: `${machine.template.name}@${machine.template.version}`,
              state: machineStateLabel(machine.state),
              error: machine.failure?.log_tail ?? machine.reason_code ?? "",
            },
          })),
      };
    },
  },
});
