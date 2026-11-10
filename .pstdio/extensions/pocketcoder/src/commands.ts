import { type CommandContext, defineCommand, params } from "@pstdio/sdk/extensions";
import { resolveExecutable } from "./executable";
import { catalogChoices, launchInstance } from "./instance-commands";
import { removeInstance } from "./instance-removal";
import { instancesFor } from "./instances";
import { labCommands } from "./lab-commands";
import { connectMachine, deleteMachine, launchMachine } from "./machine-commands";
import type { Machine } from "./machines";

import { changed } from "./resources";
import { deleteTemplate, saveTemplate } from "./template-commands";

export const instanceChoices = defineCommand({
  id: "instances.choices",
  title: "List running PocketCoder instances",
  cli: true,
  async run(ctx) {
    return (await instancesFor(ctx.projectId).list())
      .filter((instance) => instance.state === "running")
      .map((instance) => ({ value: instance.id, label: instance.name }));
  },
});
const instanceParam = params.select({
  label: "PocketCoder instance",
  required: true,
  options: { command: instanceChoices.ref, valueField: "value", labelField: "label" },
});
const instanceIdParam = params.text({ label: "Instance ID", resolvedFrom: "resource" });
const resourceId = (ctx: CommandContext, id: string | undefined, type: string) => {
  if (id) return id;
  if (ctx.resource?.type === type) return ctx.resource.id;
  throw new Error(`Choose a PocketCoder ${type}.`);
};

export const templateChoices = defineCommand({
  id: "templates.choices",
  title: "List agent templates",
  cli: true,
  params: { instance: params.text({ label: "Instance ID", required: true }) },
  async run(ctx, input) {
    const items = await instancesFor(ctx.projectId).items<{ name: string; version: string; status: string }>(
      input.instance,
      "/v1/templates",
    );
    return items
      .filter((item) => item.status === "active")
      .map((item) => ({ value: `${item.name}@${item.version}`, label: `${item.name} (${item.version})` }));
  },
});

export const startInstance = defineCommand({
  id: "instances.start",
  title: "Start instance or renew its key",
  cli: true,
  mutating: true,
  params: { instanceId: instanceIdParam },
  async run(ctx, input) {
    const instances = instancesFor(ctx.projectId);
    const id = resourceId(ctx, input.instanceId, "instance");
    const saved = await instances.get(id);
    const workspace = await ctx.workspaces.getDefault();
    const binary = await resolveExecutable({
      binary: saved.binary,
      projectRoot: workspace?.rootPath ?? workspace?.root_path ?? undefined,
    });
    const instance = await instances.start(id, binary);
    await ctx.events.emit(changed, {});
    return instance;
  },
});
export const stopInstance = defineCommand({
  id: "instances.stop",
  title: "Stop PocketCoder instance",
  cli: true,
  mutating: true,
  params: { instanceId: instanceIdParam },
  async run(ctx, input) {
    const instances = instancesFor(ctx.projectId);
    const instanceId = resourceId(ctx, input.instanceId, "instance");
    const instance = await instances.get(instanceId);
    if (instance.state === "running") {
      const machines = await instances.items<Machine>(instanceId, "/v1/workspaces");
      if (
        machines.some((machine) =>
          ["queued", "provisioning", "connected", "ready", "preserving", "terminating"].includes(machine.state),
        )
      )
        throw new Error("Delete or cancel this instance's active machines before stopping it.");
      await instances.stop(instanceId);
    }
    await ctx.events.emit(changed, {});
    return { instanceId, state: "stopped" };
  },
});
export const importTemplates = defineCommand({
  id: "templates.import",
  title: "Import agent templates",
  cli: true,
  mutating: true,
  params: { instance: instanceParam, directory: params.text({ label: "Prepared template folder", required: true }) },
  async run(ctx, input) {
    await instancesFor(ctx.projectId).importTemplates(input.instance, input.directory);
    await ctx.events.emit(changed, {});
    return { instanceId: input.instance };
  },
});

export const refresh = defineCommand({
  id: "refresh",
  title: "Refresh PocketCoder",
  cli: true,
  async run(ctx) {
    await ctx.events.emit(changed, {});
    return {};
  },
});

export const commands = [
  ...Object.values(labCommands),
  saveTemplate,
  deleteTemplate,
  catalogChoices,
  instanceChoices,
  templateChoices,
  launchInstance,
  startInstance,
  stopInstance,
  removeInstance,
  importTemplates,
  launchMachine,
  connectMachine,
  deleteMachine,
  refresh,
];
