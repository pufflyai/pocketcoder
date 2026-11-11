import type { ConversationSummary } from "@pstdio/pocketcoder-sdk";
import { type CommandContext, sessionBrowser } from "@pstdio/sdk/extensions";
import { type instancesFor, PocketCoderHttpError } from "./instances";
import type { machineConnection } from "./machine-connection";
import type { ControllerMachine } from "./machines";
import { machinePath } from "./machines";

export const machineSessionTarget = (projectId: string, session: { id: string; title: string }) => ({
  kind: "panel" as const,
  panel: sessionBrowser.panels.conversation,
  open: "pin" as const,
  resource: { type: "session", extensionId: "pstdio", projectId, id: session.id, label: session.title },
});

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
    const capabilities = await instances.request<{ requests: boolean }>(
      instanceId,
      `${machinePath(machineId)}/requests/capabilities`,
    );
    if (!capabilities.requests) throw new Error("Choose a native PocketCoder session template.");
  } catch (error) {
    if (!(error instanceof PocketCoderHttpError) || error.code !== "relay.route_not_allowed") throw error;
    throw new Error(
      "This template has no structured session connection. For Prompt Studio, launch with the relay connection and set its device and workspace IDs in metadata.",
    );
  }
}

export async function latestMachineConversation(
  instances: ReturnType<typeof instancesFor>,
  instanceId: string,
  machine: ControllerMachine,
) {
  const page = await instances.request<{ items: ConversationSummary[] }>(
    instanceId,
    `${machinePath(machine.id)}/conversations`,
  );
  return (
    page.items
      .filter((item) => item.status === "retained" && item.conversation_id)
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
      .at(0)?.conversation_id ?? undefined
  );
}
