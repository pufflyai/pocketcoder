import type { CommandContext } from "@pstdio/sdk/extensions";
import type { machineConnection } from "./machine-connection";

type Connection = Awaited<ReturnType<typeof machineConnection>>;

export function machineSessionCache(
  storage: CommandContext["storage"],
  instanceId: string,
  machineId: string,
  connection: Connection,
) {
  const target =
    connection.kind === "relay" ? [connection.kind, connection.deviceId, connection.workspaceId] : [connection.kind];
  const key = `machine-session:${instanceId}:${machineId}:${JSON.stringify(target)}`;
  return { get: () => storage.get<string>(key), set: (sessionId: string) => storage.set(key, sessionId) };
}
