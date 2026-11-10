import type { CommandContext } from "@pstdio/sdk/extensions";
import { type instancesFor, PocketCoderHttpError } from "./instances";
import type { machineConnection } from "./machine-connection";
import { machinePath } from "./machines";

export async function previousMachineSession(ctx: CommandContext, instanceId: string, machineId: string) {
  const candidates = (await ctx.workspaces.list()).filter(
    (workspace) =>
      workspace.providerId === `${ctx.extensionId}.workspace-type.machine` &&
      workspace.anchors_json?.some((anchor) => anchor.id === instanceId),
  );
  for (const old of candidates) {
    const resolved = await ctx.workspaces.resolve(old.id);
    if (resolved.providerRef?.data.machineId === machineId) return ctx.storage.get<string>(`machine-session:${old.id}`);
  }
}

export async function checkMachineConnection(
  ctx: CommandContext,
  instances: ReturnType<typeof instancesFor>,
  instanceId: string,
  machineId: string,
  connection: ReturnType<typeof machineConnection>,
) {
  if (connection.kind === "relay") {
    const device = (await ctx.account.devices()).find((device) => device.id === connection.deviceId);
    if (!device || device.current) throw new Error("Choose the machine's remote Prompt Studio device, not this host.");
    if (!device.online)
      throw new Error("The machine's Prompt Studio device is offline. Start its relay connection and try again.");
    return;
  }
  try {
    await instances.request(instanceId, `${machinePath(machineId)}/agent/status`);
  } catch (error) {
    if (!(error instanceof PocketCoderHttpError) || error.code !== "relay.route_not_allowed") throw error;
    throw new Error(
      "This template has no AgentAPI connection. For Prompt Studio, launch with the relay connection and set its device and workspace IDs in metadata.",
    );
  }
}
