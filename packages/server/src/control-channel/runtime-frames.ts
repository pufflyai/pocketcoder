import { type AgentFrame, WAITING_RUNTIME_MIN_PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import type { WSContext } from "hono/ws";
import type { LiveConnection } from "./hub";
import { maybeMarkReady } from "./runtime-readiness";
import type { CloseProtocol, WsDeps } from "./ws-types";

export async function handleRuntimeFrame(
  deps: WsDeps,
  connection: LiveConnection,
  ws: WSContext,
  frame: AgentFrame,
  closeProtocol: CloseProtocol,
) {
  switch (frame.type) {
    case "runtime_ready": {
      if (connection.protocolVersion < WAITING_RUNTIME_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "waiting runtime requires protocol v12");
        return true;
      }
      if (
        await deps.store.markWorkspaceRuntimeReady(
          frame.workspace_id,
          frame.payload.incarnationId,
          connection.epoch,
          new Date(),
        )
      ) {
        const row = await deps.store.getWorkspace(frame.workspace_id);
        if (row) await maybeMarkReady(deps, row, row.health, row.networkState);
      }
      return true;
    }
    case "finite_process":
      if (connection.protocolVersion < WAITING_RUNTIME_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "finite process requires protocol v12");
        return true;
      }
      if (await deps.store.recordFiniteProcess(frame.workspace_id, connection.epoch, frame.payload)) {
        if (frame.payload.phase === "exited" || frame.payload.phase === "lost")
          deps.hub.send(connection, "process_ack", { execution: frame.payload.execution });
      }
      return true;
    default:
      return false;
  }
}
