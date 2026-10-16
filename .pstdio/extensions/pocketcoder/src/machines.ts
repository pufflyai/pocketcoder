import {
  defineWorkspaceType,
  params,
  type WorkspaceProviderRef,
  type WorkspaceProviderResult,
  type WorkspaceProviderState,
} from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";

export interface Machine {
  id: string;
  state:
    | "queued"
    | "provisioning"
    | "connected"
    | "ready"
    | "preserving"
    | "terminating"
    | "succeeded"
    | "failed"
    | "canceled"
    | "expired"
    | "preserved";
  agent_state: string;
  change_cursor: number;
  reason_code: string | null;
  failure: { log_tail: string } | null;
}

export const machinePath = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;
export const isTerminal = (machine: Machine) =>
  ["succeeded", "failed", "canceled", "expired", "preserved"].includes(machine.state);
export const machineRef = (ref: WorkspaceProviderRef) => {
  if (ref.version !== 1 || typeof ref.data.instanceId !== "string" || typeof ref.data.machineId !== "string") {
    throw new Error("Invalid PocketCoder machine reference.");
  }
  return { instanceId: ref.data.instanceId, machineId: ref.data.machineId };
};

export function projectMachine(extensionId: string, instanceId: string, machine: Machine) {
  const states: Record<Machine["state"], WorkspaceProviderState> = {
    queued: "provisioning",
    provisioning: "provisioning",
    connected: "provisioning",
    ready: "ready",
    preserving: "provisioning",
    terminating: "deleting",
    succeeded: "archived",
    failed: "failed",
    canceled: "cancelled",
    expired: "failed",
    preserved: "archived",
  };
  const providerRef = { version: 1, data: { instanceId, machineId: machine.id } };
  const state = states[machine.state];
  return {
    providerRef,
    state,
    executionKind: "remote",
    executionTarget: { kind: "remote", providerId: `${extensionId}.workspace-type.machine`, providerRef },
    displayPath: `PocketCoder / ${machine.id}`,
    capabilities: { files: "none", diff: false, merge: false, rebase: false, archive: false, delete: true },
    ...(state === "failed"
      ? {
          error: {
            code: machine.reason_code ?? machine.state,
            message:
              machine.failure?.log_tail || `Machine ${machine.state}: ${machine.reason_code ?? "no reason supplied"}.`,
            retryable: false,
          },
        }
      : {}),
  } satisfies WorkspaceProviderResult;
}

export const providerParams = {
  instance: params.text({ label: "PocketCoder instance ID", required: true }),
  template: params.text({ label: "Agent template", required: true }),
  templateVersion: params.text({ label: "Template version (optional)" }),
};

export function createMachineProvider(getInstances = instancesFor) {
  return defineWorkspaceType({
    id: "machine",
    label: "PocketCoder agent machine",
    icon: "server",
    params: providerParams,
    async create(ctx, input) {
      const { instance, template, templateVersion } = input.params;
      if (typeof instance !== "string" || typeof template !== "string" || !template.trim())
        throw new Error("Choose an instance and agent template.");
      const machine = await getInstances(ctx.projectId).request<Machine>(instance, "/v1/workspaces", {
        method: "POST",
        headers: { "Idempotency-Key": input.operationId },
        body: JSON.stringify({
          external_id: input.workspaceId,
          template: { name: template, ...(templateVersion ? { version: templateVersion } : {}) },
        }),
        signal: input.signal,
      });
      return projectMachine(ctx.extensionId, instance, machine);
    },
    async resolve(ctx, input) {
      const { instanceId, machineId } = machineRef(input.providerRef);
      return projectMachine(
        ctx.extensionId,
        instanceId,
        await getInstances(ctx.projectId).request<Machine>(instanceId, machinePath(machineId)),
      );
    },
    async cancel(ctx, input) {
      const { instanceId, machineId } = machineRef(input.providerRef);
      const machine = await getInstances(ctx.projectId).request<Machine>(
        instanceId,
        `${machinePath(machineId)}/cancel`,
        { method: "POST" },
      );
      return projectMachine(ctx.extensionId, instanceId, machine);
    },
    async delete(ctx, input) {
      const { instanceId, machineId } = machineRef(input.providerRef);
      const instances = getInstances(ctx.projectId);
      let machine = await instances.request<Machine>(instanceId, machinePath(machineId));
      if (!isTerminal(machine))
        machine = await instances.request<Machine>(instanceId, `${machinePath(machineId)}/cancel`, { method: "POST" });
      while (!isTerminal(machine)) {
        const change = await instances.request<{ workspace: Machine }>(
          instanceId,
          `${machinePath(machineId)}/changes?after=${machine.change_cursor}&wait=30`,
        );
        machine = change.workspace;
      }
    },
  });
}
