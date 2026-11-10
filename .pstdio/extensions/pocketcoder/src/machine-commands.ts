import { randomUUID } from "node:crypto";
import { commandRef, defineCommand, params, workbenchPages, workbenchResourceKinds } from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { machineConnection } from "./machine-connection";
import { checkMachineConnection, previousMachineSession } from "./machine-session";
import { unavailableMachineMessage } from "./machine-status";
import { type ControllerMachine, isTerminal, launchInputOf, machinePath, providerParams } from "./machines";
import { changed } from "./resources";

const ref = (id: string) => commandRef({ extensionId: "pocketcoder.pocketcoder", id });
const machineParams = {
  instance: params.text({ label: "Instance ID", required: true }),
  machineId: params.text({ label: "Machine ID", required: true }),
};
export const connectionParam = params.select({
  label: "Agent connection",
  defaultValue: "agentapi",
  options: [
    { value: "agentapi", label: "AgentAPI" },
    { value: "relay", label: "Prompt Studio Cloud relay" },
  ],
});

export function createMachineCommands(getInstances = instancesFor) {
  const launchMachine = defineCommand({
    id: "machines.launch",
    title: "Launch agent machine",
    cli: true,
    mutating: true,
    params: {
      instance: params.select({
        label: "PocketCoder instance",
        required: true,
        options: { command: ref("instances.choices"), valueField: "value", labelField: "label" },
      }),
      template: params.select({
        label: "Agent template",
        required: true,
        options: {
          command: ref("templates.choices"),
          valueField: "value",
          labelField: "label",
          params: { instance: params.valueOf("instance") },
        },
      }),
      connection: connectionParam,
      externalId: providerParams.externalId,
      launchInput: providerParams.launchInput,
      metadata: providerParams.metadata,
    },
    async run(ctx, input) {
      const separator = input.template.lastIndexOf("@");
      if (separator < 1) throw new Error("Choose a versioned agent template.");
      const metadata = launchInputOf(input.metadata) ?? {};
      if (input.connection) metadata["pstdio.connection"] = input.connection;
      const machine = await getInstances(ctx.projectId).request<ControllerMachine>(input.instance, "/v1/workspaces", {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          external_id: input.externalId || randomUUID(),
          template: { name: input.template.slice(0, separator), version: input.template.slice(separator + 1) },
          launch_input: launchInputOf(input.launchInput),
          metadata,
        }),
      });
      await ctx.events.emit(changed, {});
      return { instanceId: input.instance, machineId: machine.id };
    },
  });
  const connectMachine = defineCommand({
    id: "machines.connect",
    title: "Connect to agent",
    cli: true,
    mutating: true,
    params: machineParams,
    async run(ctx, input) {
      const instances = getInstances(ctx.projectId);
      const machine = await instances.request<ControllerMachine>(input.instance, machinePath(input.machineId));
      await ctx.events.emit(changed, {});
      const unavailable = unavailableMachineMessage(machine);
      if (unavailable) throw new Error(unavailable);
      const connection = machineConnection(machine.metadata);
      const key = `machine-session:${input.instance}:${machine.id}`;
      let sessionId = await ctx.storage.get<string>(key);
      if (!sessionId && connection.kind === "agentapi")
        sessionId = await previousMachineSession(ctx, input.instance, machine.id);
      await checkMachineConnection(ctx, instances, input.instance, machine.id, connection);
      const existing = sessionId ? await ctx.sessions.get(sessionId) : null;
      const session =
        existing ??
        (await ctx.sessions.create({
          title: `PocketCoder: ${machine.external_id}`,
          ...(connection.kind === "relay"
            ? {
                deviceId: connection.deviceId,
                workspaceId: connection.workspaceId,
                harness: { harnessId: "pstdio.harness-codex.harness.codex" },
              }
            : {
                harness: {
                  harnessId: `${ctx.extensionId}.harness.agent`,
                },
              }),
        }));
      if (connection.kind === "agentapi") await instances.bindSession(session.id, input.instance, machine.id);
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
      return { machineId: machine.id, sessionId: session.id };
    },
  });
  const deleteMachine = defineCommand({
    id: "machines.delete",
    title: "Delete machine",
    cli: true,
    mutating: true,
    params: machineParams,
    async run(ctx, input) {
      const instances = getInstances(ctx.projectId);
      let machine = await instances.request<ControllerMachine>(input.instance, machinePath(input.machineId));
      if (!isTerminal(machine))
        machine = await instances.request(input.instance, `${machinePath(machine.id)}/cancel`, { method: "POST" });
      while (!isTerminal(machine)) {
        const change = await instances.request<{ workspace: ControllerMachine }>(
          input.instance,
          `${machinePath(machine.id)}/changes?after=${machine.change_cursor}&wait=30`,
        );
        machine = change.workspace;
      }
      const dismissedKey = `dismissed-machines:${input.instance}`;
      const dismissed = (await ctx.storage.get<string[]>(dismissedKey)) ?? [];
      await ctx.storage.set(dismissedKey, [...new Set([...dismissed, machine.id])]);
      await ctx.events.emit(changed, {});
      return { machineId: machine.id, state: machine.state };
    },
  });
  return { launchMachine, connectMachine, deleteMachine };
}

export const { launchMachine, connectMachine, deleteMachine } = createMachineCommands();
