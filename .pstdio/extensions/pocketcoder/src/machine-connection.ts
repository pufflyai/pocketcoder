import { PocketCoderHttpError } from "./instances";

// The template decides how Prompt Studio talks to a machine. A template with a session adapter
// serves structured requests; a template without one refuses that route, so it can only use the relay.
export async function machineConnection(
  capabilities: () => Promise<{ requests: boolean }>,
  metadata: Record<string, string>,
) {
  try {
    if (!(await capabilities()).requests) throw new Error("Choose a native PocketCoder session template.");
    return { kind: "session" as const };
  } catch (error) {
    if (!(error instanceof PocketCoderHttpError) || error.code !== "relay.route_not_allowed") throw error;
  }
  const deviceId = metadata["pstdio.device_id"];
  const workspaceId = metadata["pstdio.workspace_id"];
  if (!deviceId || !workspaceId)
    throw new Error(
      "This template connects through the Prompt Studio relay, which needs a device and workspace. Set pstdio.device_id and pstdio.workspace_id in the machine metadata after enrolling the machine with a workspace-scoped, expiring credential.",
    );
  return { kind: "relay" as const, deviceId, workspaceId };
}
