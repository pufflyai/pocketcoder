import type { CommandContext } from "@pstdio/sdk/extensions";
import type { machineConnection } from "./machine-connection";

type Connection = Awaited<ReturnType<typeof machineConnection>>;
type Binding = Connection & { sessionId: string };

export function machineSessionCache(
  storage: CommandContext["storage"],
  instanceId: string,
  machineId: string,
  connection: Connection,
) {
  const key = `machine-session:${instanceId}:${machineId}`;
  return {
    async get() {
      const binding = await storage.get<Binding>(key);
      if (!binding || binding.kind !== connection.kind) return undefined;
      if (
        binding.kind === "relay" &&
        connection.kind === "relay" &&
        (binding.deviceId !== connection.deviceId || binding.workspaceId !== connection.workspaceId)
      )
        return undefined;
      return binding.sessionId;
    },
    set: (sessionId: string) => storage.set(key, { ...connection, sessionId }),
  };
}
