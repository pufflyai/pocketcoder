import {
  type CommandContext,
  defineCommand,
  params,
  workbenchPages,
  workbenchResourceKinds,
} from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { type Machine, machineRef } from "./machines";
import { changed, instanceKind } from "./resources";

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

export const launchInstance = defineCommand({
  id: "instances.launch",
  title: "Launch PocketCoder instance",
  cli: true,
  mutating: true,
  palette: [{ group: "PocketCoder", label: "Launch PocketCoder instance" }],
  params: {
    name: params.text({ label: "Instance name", required: true }),
    binary: params.text({ label: "PocketCoder 1.0 executable", required: true, defaultValue: "pocketcoder" }),
    templates: params.text({ label: "Prepared agent template folder (optional)" }),
  },
  async run(ctx, input) {
    const instance = await instancesFor(ctx.projectId).launch(input);
    await ctx.events.emit(changed, {});
    return instance;
  },
});

export const startInstance = defineCommand({
  id: "instances.start",
  title: "Start instance or renew its key",
  cli: true,
  mutating: true,
  params: { instanceId: instanceIdParam },
  async run(ctx, input) {
    const instance = await instancesFor(ctx.projectId).start(resourceId(ctx, input.instanceId, "instance"));
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

export const launchMachine = defineCommand({
  id: "machines.launch",
  title: "Launch agent machine",
  cli: true,
  mutating: true,
  palette: [{ group: "PocketCoder", label: "Launch agent machine" }],
  params: {
    instance: instanceParam,
    template: params.select({
      label: "Agent template",
      required: true,
      options: {
        command: templateChoices.ref,
        valueField: "value",
        labelField: "label",
        params: { instance: params.valueOf("instance") },
      },
    }),
  },
  async run(ctx, input) {
    const separator = input.template.lastIndexOf("@");
    if (separator < 1) throw new Error("Choose a versioned agent template.");
    const workspace = await ctx.workspaces.create({
      project_id: ctx.projectId,
      shorthand_base: "PC-MACHINE",
      provider_id: `${ctx.extensionId}.workspace-type.machine`,
      params: {
        instance: input.instance,
        template: input.template.slice(0, separator),
        templateVersion: input.template.slice(separator + 1),
      },
      anchors: [{ type: instanceKind.id, id: input.instance, role: "context" }],
    });
    await ctx.events.emit(changed, {});
    return { workspaceId: workspace.id };
  },
});
export const connectMachine = defineCommand({
  id: "machines.connect",
  title: "Connect to PocketCoder agent",
  cli: true,
  mutating: true,
  params: { workspaceId: params.text({ label: "pstdio workspace ID", resolvedFrom: "resource" }) },
  async run(ctx, input) {
    const workspace = await ctx.workspaces.get(resourceId(ctx, input.workspaceId, "workspace"));
    if (workspace?.provider_id !== `${ctx.extensionId}.workspace-type.machine`)
      throw new Error("Choose a PocketCoder machine workspace.");
    const resolved = await ctx.workspaces.resolve(workspace.id);
    if (resolved.state !== "ready" || !resolved.providerRef)
      throw new Error(`Machine is ${resolved.state}. Wait until it is ready.`);
    machineRef(resolved.providerRef);
    const connectionKey = `machine-session:${workspace.id}`;
    const sessionId = await ctx.storage.get<string>(connectionKey);
    const existing = sessionId ? await ctx.sessions.get(sessionId) : null;
    const session =
      existing ??
      (await ctx.sessions.create({
        title: `PocketCoder: ${workspace.workspace_shorthand}`,
        workspaceId: workspace.id,
        harness: { harnessId: `${ctx.extensionId}.harness.agent` },
      }));
    await ctx.storage.set(connectionKey, session.id);
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
export const deleteMachine = defineCommand({
  id: "machines.delete",
  title: "Delete agent machine",
  cli: true,
  mutating: true,
  params: { workspaceId: params.text({ label: "pstdio workspace ID", resolvedFrom: "resource" }) },
  async run(ctx, input) {
    const workspace = await ctx.workspaces.get(resourceId(ctx, input.workspaceId, "workspace"));
    if (workspace?.provider_id !== `${ctx.extensionId}.workspace-type.machine`)
      throw new Error("Choose a PocketCoder machine workspace.");
    await ctx.workspaces.delete(workspace.id);
    await ctx.events.emit(changed, {});
    return { workspaceId: workspace.id };
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
  instanceChoices,
  templateChoices,
  launchInstance,
  startInstance,
  stopInstance,
  importTemplates,
  launchMachine,
  connectMachine,
  deleteMachine,
  refresh,
];
