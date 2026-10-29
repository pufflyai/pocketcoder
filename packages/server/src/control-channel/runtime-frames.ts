import {
  type AgentFrame,
  EXECUTION_DISPATCH_MIN_PROTOCOL_VERSION,
  WAITING_RUNTIME_MIN_PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
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
    case "process_absent":
    case "process_cancel_result":
      return handleDispatchReply(deps, connection, ws, frame, closeProtocol);
    case "finite_process":
      if (connection.protocolVersion < WAITING_RUNTIME_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "finite process requires protocol v12");
        return true;
      }
      if (await deps.store.recordFiniteProcess(frame.workspace_id, connection.epoch, frame.payload)) {
        if (frame.payload.phase === "exited" || frame.payload.phase === "lost") {
          deps.hub.send(connection, "process_ack", { execution: frame.payload.execution });
          if (await deps.store.executions.get(frame.payload.execution))
            await deps.store.executions.acknowledge(frame.payload.execution, frame.payload.fingerprint, new Date());
        }
      }
      return true;
    default:
      return false;
  }
}

async function handleDispatchReply(
  deps: WsDeps,
  connection: LiveConnection,
  ws: WSContext,
  frame: Extract<AgentFrame, { type: "process_absent" | "process_cancel_result" }>,
  closeProtocol: CloseProtocol,
) {
  if (connection.protocolVersion < EXECUTION_DISPATCH_MIN_PROTOCOL_VERSION) {
    closeProtocol(ws, "execution dispatch requires protocol v13");
    return true;
  }
  if (frame.payload.execution.workspaceId !== connection.workspaceId) return true;
  if (frame.type === "process_absent") {
    await deps.executionDispatcher?.absent(frame.payload.execution, connection.epoch);
    return true;
  }
  const record = await deps.store.executions.get(frame.payload.execution);
  if (record?.cancel?.cancelId === frame.payload.cancelId && frame.payload.status === "canceled") {
    if (
      await deps.store.executions.observe(
        frame.payload.execution,
        record.acceptance.fingerprint,
        "canceled",
        connection.epoch,
        new Date(),
      )
    )
      await deps.store.executions.acknowledge(frame.payload.execution, record.acceptance.fingerprint, new Date());
  }
  return true;
}
