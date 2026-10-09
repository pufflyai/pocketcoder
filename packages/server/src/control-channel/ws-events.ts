import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import { type AgentFrame, AgentFrameSchema, isTerminal, MAX_FRAME_BYTES } from "@pstdio/pocketcoder-contracts";
import type { WSContext, WSEvents } from "hono/ws";
import { type LiveConnection, MAX_INFLIGHT_RELAY } from "./hub";
import { execSpecOf, sourceCredentialFor } from "./ws-auth";
import { handleConnectedFrame } from "./ws-frame-handler";
import type { CloseProtocol, WsAuth, WsDeps } from "./ws-types";

const HEARTBEAT_SECONDS = 15;
const LOG_CHUNK_BYTES = 65_536;

type RegisteredFrame = Extract<AgentFrame, { type: "registered" }>;

async function registerConnection(
  deps: WsDeps,
  auth: WsAuth,
  ws: WSContext,
  frame: RegisteredFrame,
  closeProtocol: CloseProtocol,
): Promise<LiveConnection | null> {
  const row = await deps.store.getWorkspace(auth.workspaceId);
  if (!row || isTerminal(row.state)) {
    closeProtocol(ws, "workspace ended");
    return null;
  }
  if (frame.payload.template.digest !== row.templateDigest) {
    closeProtocol(ws, "template digest mismatch");
    return null;
  }
  if (
    auth.mode === "reconnect" &&
    deps.checkpointTransfers &&
    row.launchMode === "restore" &&
    row.state === "connected"
  ) {
    await deps.scheduler.beginTermination(row, "failed", "restore_failed", new Date());
    closeProtocol(ws, "restore interrupted before readiness");
    return null;
  }
  const epoch = row.connectionEpoch + 1;
  let reconnectCredential: string | undefined;
  let sourceCredential: string | null = null;
  if (auth.mode === "register") {
    try {
      sourceCredential = await sourceCredentialFor(deps, row);
    } catch {
      deps.log?.(`workspace ${row.id}: source credential resolution failed`);
      await deps.scheduler.finalize(row, "failed", "secret_resolution_failed", new Date());
      closeProtocol(ws, "source credential unavailable");
      return null;
    }
    reconnectCredential = generateOpaqueSecret();
    const updated = await deps.store.transition(row.id, {
      from: ["provisioning"],
      to: "connected",
      at: new Date(),
      patch: {
        connectionEpoch: epoch,
        connectedAt: new Date(),
        disconnectedAt: null,
        registrationDigest: null,
        registrationExpiresAt: null,
        reconnectDigest: digestOpaque(deps.pepper, reconnectCredential),
      },
    });
    if (!updated) {
      closeProtocol(ws, "registration no longer valid");
      return null;
    }
    void deps.cleanupInput?.(row.id).catch(() => {});
  } else {
    await deps.store.updateWorkspace(
      row.id,
      { connectionEpoch: epoch, connectedAt: new Date(), disconnectedAt: null },
      new Date(),
    );
  }
  const connection = deps.hub.attach(row.id, frame.connection_id, epoch, ws, auth.protocolVersion);
  connection.lastSeqIn = frame.seq;
  connection.registered = true;
  try {
    const restoreMode = deps.checkpointTransfers ? "controller_archive" : "provider_installed";
    const exec = execSpecOf(row, sourceCredential, restoreMode);
    if (deps.checkpointTransfers && row.launchMode === "restore" && row.state !== "ready") {
      const current = await deps.store.getWorkspace(row.id);
      const transfer = current && (await deps.checkpointTransfers?.restoreGrant(connection, current));
      if (!transfer || !exec.restore || deps.hub.get(row.id) !== connection) {
        deps.hub.detach(connection);
        await deps.checkpointTransfers?.disconnected?.(connection);
        closeProtocol(ws, "restore transfer unavailable");
        return null;
      }
      exec.restore.transfer = transfer;
    }
    deps.hub.send(connection, "registered_ack", {
      epoch,
      ...(reconnectCredential ? { reconnect_credential: reconnectCredential } : {}),
      limits: {
        max_frame_bytes: MAX_FRAME_BYTES,
        max_inflight_relay: MAX_INFLIGHT_RELAY,
        log_chunk_bytes: LOG_CHUNK_BYTES,
        heartbeat_seconds: HEARTBEAT_SECONDS,
      },
      exec,
    });
    deps.hub.resumeTerminals(connection);
    return connection;
  } catch (error) {
    deps.hub.detach(connection);
    await deps.checkpointTransfers?.disconnected?.(connection);
    throw error;
  }
}

function parseFrame(
  data: string | ArrayBuffer | Uint8Array,
  auth: WsAuth,
  connection: LiveConnection | null,
  ws: WSContext,
  closeProtocol: CloseProtocol,
): AgentFrame | null {
  const raw = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
    closeProtocol(ws, "frame too large");
    return null;
  }
  const parsed = AgentFrameSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    closeProtocol(ws, "invalid frame");
    return null;
  }
  const frame = parsed.data;
  if (frame.v !== auth.protocolVersion) {
    closeProtocol(ws, "wrong protocol version");
    return null;
  }
  if (frame.workspace_id !== auth.workspaceId) {
    closeProtocol(ws, "wrong workspace");
    return null;
  }
  if (!connection) {
    if (frame.type !== "registered") closeProtocol(ws, "not registered");
    return frame.type === "registered" ? frame : null;
  }
  if (frame.connection_id !== connection.connectionId) {
    closeProtocol(ws, "wrong connection");
    return null;
  }
  if (frame.seq <= connection.lastSeqIn) {
    closeProtocol(ws, "sequence violation");
    return null;
  }
  return frame;
}

async function processMessage(
  deps: WsDeps,
  auth: WsAuth,
  connection: LiveConnection | null,
  data: string | ArrayBuffer | Uint8Array,
  ws: WSContext,
  closeProtocol: CloseProtocol,
): Promise<LiveConnection | null> {
  const frame = parseFrame(data, auth, connection, ws, closeProtocol);
  if (!frame) return connection;
  if (!connection) {
    return await registerConnection(deps, auth, ws, frame as RegisteredFrame, closeProtocol);
  }
  connection.lastSeqIn = frame.seq;
  await handleConnectedFrame(deps, connection, ws, frame, closeProtocol);
  return connection;
}

async function detachConnection(deps: WsDeps, auth: WsAuth, connection: LiveConnection | null): Promise<void> {
  if (!connection) return;
  const wasLive = deps.hub.detach(connection);
  await deps.checkpointTransfers?.disconnected?.(connection);
  connection.registered = false;
  if (!wasLive) return;
  const row = await deps.store.getWorkspace(auth.workspaceId);
  if (row && deps.checkpointTransfers && row.launchMode === "restore" && row.state === "connected") {
    // Installation cannot be replayed safely over a mount that setup may have changed.
    await deps.scheduler.beginTermination(row, "failed", "restore_failed", new Date());
    return;
  }
  if (row && !isTerminal(row.state) && !["terminating", "preserving"].includes(row.state)) {
    await deps.store.updateWorkspace(row.id, { disconnectedAt: new Date() }, new Date());
  }
}

// Frames are processed strictly in arrival order to preserve log and state sequencing.
export function agentWsEvents(deps: WsDeps) {
  return (c: { get: (key: string) => unknown }): WSEvents => {
    const auth = c.get("wsAuth") as WsAuth;
    let conn: LiveConnection | null = null;
    let closed = false;
    let pipeline: Promise<void> = Promise.resolve();

    const closeProtocol = (ws: WSContext, message: string) => {
      deps.log?.(`ws ${auth.workspaceId}: protocol error: ${message}`);
      ws.close(1008, message);
    };

    return {
      onMessage: (event, ws) => {
        if (closed) return;
        pipeline = pipeline.then(async () => {
          try {
            conn = await processMessage(
              deps,
              auth,
              conn,
              event.data as string | ArrayBuffer | Uint8Array,
              ws,
              closeProtocol,
            );
            if (closed) await detachConnection(deps, auth, conn);
          } catch (error) {
            deps.log?.(`ws ${auth.workspaceId}: ${String(error)}`);
            closeProtocol(ws, "internal error");
          }
        });
      },
      onClose: () => {
        closed = true;
        void detachConnection(deps, auth, conn);
      },
    };
  };
}
