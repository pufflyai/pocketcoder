import type { LiveConnection } from "./hub";
import type { WsDeps } from "./ws-types";

export async function activeConnectionWorkspace(
  deps: WsDeps,
  connection: LiveConnection,
  states = ["connected", "ready"],
) {
  const row = await deps.store.getWorkspace(connection.workspaceId);
  if (
    !row ||
    row.connectionEpoch !== connection.epoch ||
    !states.includes(row.state) ||
    row.purgeRequestedAt ||
    row.deadlineAt <= new Date() ||
    deps.hub.get(row.id) !== connection
  )
    return null;
  return row;
}
