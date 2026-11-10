export function machineConnection(metadata: Record<string, string>) {
  const kind = metadata["pstdio.connection"] ?? "agentapi";
  if (kind === "agentapi") return { kind: "agentapi" as const };
  if (kind !== "relay") throw new Error(`Unknown agent connection: ${kind}.`);
  const deviceId = metadata["pstdio.device_id"];
  const workspaceId = metadata["pstdio.workspace_id"];
  if (!deviceId || !workspaceId)
    throw new Error(
      "Prompt Studio relay needs a device and workspace. Set pstdio.device_id and pstdio.workspace_id in the machine metadata after enrolling the machine with a workspace-scoped, expiring credential.",
    );
  return { kind: "relay" as const, deviceId, workspaceId };
}
