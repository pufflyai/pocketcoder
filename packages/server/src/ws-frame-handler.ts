import {
  type AgentFrame,
  isTerminal,
  STREAMING_MIN_PROTOCOL_VERSION,
  snapshotServices,
  TERMINAL_MIN_PROTOCOL_VERSION,
  type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { WSContext } from "hono/ws";
import type { LiveConnection } from "./hub";
import type { CloseProtocol, WsDeps } from "./ws-types";

type ServiceHealthFrame = Extract<AgentFrame, { type: "service_health" }>;
type ProcessStateFrame = Extract<AgentFrame, { type: "process_state" }>;
type AgentStateFrame = Extract<AgentFrame, { type: "agent_state" }>;
type NetworkStateFrame = Extract<AgentFrame, { type: "network_state" }>;

async function handleServiceHealth(deps: WsDeps, frame: ServiceHealthFrame): Promise<void> {
  const row = await deps.store.getWorkspace(frame.workspace_id);
  if (!row || isTerminal(row.state)) return;
  const health = { ...row.health, [frame.payload.service]: frame.payload.health };
  await deps.store.updateWorkspace(row.id, { health }, new Date());
  await maybeMarkReady(deps, row, health, row.networkState);
}

async function maybeMarkReady(
  deps: WsDeps,
  row: WorkspaceRow,
  health: Record<string, string>,
  networkState: WorkspaceRow["networkState"],
) {
  if (row.state !== "connected") return;
  const allRequiredHealthy = Object.entries(snapshotServices(row.templateSnapshot))
    .filter(([, service]) => service.required)
    .every(([name]) => health[name] === "healthy");
  if (!allRequiredHealthy) return;
  if (row.templateSnapshot.spec.network.mode === "restricted" && networkState !== "ready") return;
  const now = new Date();
  if (row.sourceDescriptor && !row.resolvedSource) {
    await deps.scheduler.finalize(row, "failed", "source_resolution_failed", now);
    return;
  }
  await deps.store.transition(row.id, {
    from: ["connected"],
    to: "ready",
    at: now,
    patch: { readyAt: now, lastActivityAt: now, launchInput: null },
  });
}

async function handleProcessState(deps: WsDeps, frame: ProcessStateFrame): Promise<void> {
  const row = await deps.store.getWorkspace(frame.workspace_id);
  if (!row || isTerminal(row.state) || row.state === "preserving") return;
  if (frame.payload.phase === "running") {
    await maybeMarkReady(deps, row, row.health, row.networkState);
    return;
  }
  if (frame.payload.phase !== "exited") return;
  const now = new Date();
  if (row.state === "terminating") {
    await deps.scheduler.finalize(
      row,
      (row.terminalIntent ?? "failed") as WorkspaceState,
      row.reasonCode,
      now,
    );
    return;
  }
  await deps.scheduler.handleProcessExit(row, frame.payload.exit_code ?? null, now);
}

async function handleAgentState(deps: WsDeps, frame: AgentStateFrame): Promise<void> {
  const row = await deps.store.getWorkspace(frame.workspace_id);
  if (!row || isTerminal(row.state) || row.agentState === frame.payload.state) return;
  const now = new Date();
  await deps.store.updateWorkspace(
    row.id,
    {
      agentState: frame.payload.state,
      ...(frame.payload.state === "running" ? { lastActivityAt: now } : {}),
    },
    now,
  );
}

async function handleNetworkState(deps: WsDeps, frame: NetworkStateFrame): Promise<void> {
  const row = await deps.store.getWorkspace(frame.workspace_id);
  if (!row || isTerminal(row.state)) return;
  await deps.store.updateWorkspace(row.id, { networkState: frame.payload.state }, new Date());
  if (frame.payload.state === "degraded") {
    await deps.scheduler.finalize(row, "failed", "network_policy_failed", new Date());
  }
}

export async function handleConnectedFrame(
  deps: WsDeps,
  connection: LiveConnection,
  ws: WSContext,
  frame: AgentFrame,
  closeProtocol: CloseProtocol,
): Promise<void> {
  switch (frame.type) {
    case "registered":
      closeProtocol(ws, "already registered");
      return;
    case "heartbeat":
      if (frame.payload.agentapi_state === "running") {
        await deps.store.updateWorkspace(
          frame.workspace_id,
          { lastActivityAt: new Date() },
          new Date(),
        );
      }
      return;
    case "service_health":
      await handleServiceHealth(deps, frame);
      return;
    case "agent_state":
      await handleAgentState(deps, frame);
      return;
    case "network_state":
      await handleNetworkState(deps, frame);
      return;
    case "log_chunk":
      await deps.store.appendLogs(frame.workspace_id, [
        {
          stream: frame.payload.stream,
          occurredAt: new Date(frame.payload.occurred_at),
          content: Uint8Array.from(Buffer.from(frame.payload.content_b64, "base64")),
        },
      ]);
      return;
    case "process_state":
      await handleProcessState(deps, frame);
      return;
    case "proxy_response":
      deps.hub.resolveRelay(connection, frame.payload);
      return;
    case "proxy_stream_start":
      if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "stream frame requires protocol v5");
        return;
      }
      deps.hub.startRelayStream(connection, frame.payload);
      return;
    case "proxy_stream_chunk":
      if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "stream frame requires protocol v5");
        return;
      }
      deps.hub.pushRelayStreamChunk(connection, frame.payload);
      return;
    case "proxy_stream_end":
      if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "stream frame requires protocol v5");
        return;
      }
      deps.hub.endRelayStream(connection, frame.payload);
      return;
    case "terminal_opened":
      if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "terminal frame requires protocol v4");
        return;
      }
      deps.hub.terminalOpened(connection, frame.payload);
      return;
    case "terminal_output":
      if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "terminal frame requires protocol v4");
        return;
      }
      deps.hub.terminalOutput(connection, frame.payload);
      return;
    case "terminal_closed":
      if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
        closeProtocol(ws, "terminal frame requires protocol v4");
        return;
      }
      deps.hub.terminalClosed(connection, frame.payload);
      return;
    case "termination_ack":
      return;
    case "source_resolved":
      await deps.persistence?.sourceResolved(frame.workspace_id, { kind: "git", ...frame.payload });
      return;
    case "checkpoint_status":
      deps.hub.resolveCheckpoint(connection, frame.payload.operation_id, frame.payload.phase);
      return;
    case "attachment_ack":
      deps.hub.pushAttachment(connection, { kind: "ack", payload: frame.payload });
      return;
    case "attachment_result":
      deps.hub.pushAttachment(connection, { kind: "result", payload: frame.payload });
      return;
    case "attachment_resolved":
      deps.hub.pushAttachment(connection, { kind: "resolved", payload: frame.payload });
      return;
    case "output_published":
      await deps.persistence?.publishOutput(
        frame.workspace_id,
        frame.payload.name,
        frame.payload.value,
      );
      return;
    case "restore_status":
      return;
    case "conversation_message": {
      const workspace = await deps.store.getWorkspace(frame.workspace_id);
      if (!workspace || isTerminal(workspace.state)) return;
      try {
        await deps.store.appendConversationMessage({
          workspaceId: frame.workspace_id,
          messageId: frame.payload.message_id,
          role: frame.payload.role,
          content: frame.payload.content,
          occurredAt: new Date(frame.payload.occurred_at),
          metadata: frame.payload.metadata,
          createdAt: new Date(),
        });
      } catch (error) {
        deps.log?.(`conversation ${frame.workspace_id}: ${String(error)}`);
      }
      return;
    }
  }
}
