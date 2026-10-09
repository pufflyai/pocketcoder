import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CHECKPOINT_ARCHIVE_FORMAT,
  type CheckpointPrepared,
  PROTOCOL_VERSION,
  type PrepareCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { WSContext } from "hono/ws";
import { Hub } from "./hub";

const workspaceId = randomUUID();
const payload: PrepareCheckpointArchive = {
  operation_id: randomUUID(),
  checkpoint_id: randomUUID(),
  deadline_ms: 1000,
  mounts: [],
  max_archive_bytes: 65536,
  max_index_bytes: 65536,
  max_queue_bytes: 65536,
};

test("archive preparation uses a real control socket and retains the exact connection", async () => {
  const hub = new Hub();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      open(ws) {
        const connection = hub.attach(
          workspaceId,
          randomUUID(),
          1,
          new WSContext({
            send: (message) => {
              ws.send(message);
            },
            close: (code, reason) => {
              ws.close(code, reason);
            },
            raw: ws,
            readyState: ws.readyState,
          }),
          PROTOCOL_VERSION,
        );
        connection.registered = true;
        connected();
      },
      message(_ws, raw) {
        const declaration = JSON.parse(String(raw));
        const connection = hub.get(workspaceId);
        if (connection) hub.resolveCheckpointArchive(connection, declaration);
      },
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    socket.send(
      JSON.stringify({
        operation_id: frame.payload.operation_id,
        checkpoint_id: frame.payload.checkpoint_id,
        header: {
          format: CHECKPOINT_ARCHIVE_FORMAT,
          checkpoint_id: payload.checkpoint_id,
          workspace_id: workspaceId,
          template_digest: `sha256:${"a".repeat(64)}`,
          mounts: [],
        },
        archive_bytes: 4096,
      }),
    );
  };
  try {
    await ready;
    const result = await hub.prepareCheckpointArchive(workspaceId, payload);
    expect(result?.connection).toBe(hub.get(workspaceId));
    expect(result?.declaration.archive_bytes).toBe(4096);
  } finally {
    socket.close();
    hub.close(workspaceId);
    await server.stop(true);
  }
});

test("replacement and deadline cannot resolve archive declaration for another connection", async () => {
  const hub = new Hub();
  let epoch = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      open(ws) {
        const connection = hub.attach(
          workspaceId,
          randomUUID(),
          ++epoch,
          new WSContext({
            send: (message) => {
              ws.send(message);
            },
            close: (code, reason) => {
              ws.close(code, reason);
            },
            raw: ws,
            readyState: ws.readyState,
          }),
          PROTOCOL_VERSION,
        );
        connection.registered = true;
      },
      message() {},
    },
  });
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    return socket;
  }
  const first = await connect();
  let second: WebSocket | undefined;
  try {
    const original = hub.get(workspaceId);
    if (!original) throw new Error("Original connection missing");
    const pending = hub.prepareCheckpointArchive(workspaceId, payload);
    second = await connect();
    expect(await pending).toBe(null);
    const current = hub.get(workspaceId);
    if (!current) throw new Error("Current connection missing");
    const next = hub.prepareCheckpointArchive(workspaceId, { ...payload, deadline_ms: 30 });
    const declaration: CheckpointPrepared = {
      operation_id: payload.operation_id,
      checkpoint_id: payload.checkpoint_id,
      header: {
        format: CHECKPOINT_ARCHIVE_FORMAT,
        checkpoint_id: payload.checkpoint_id,
        workspace_id: workspaceId,
        template_digest: `sha256:${"a".repeat(64)}`,
        mounts: [],
      },
      archive_bytes: 4096,
    };
    hub.resolveCheckpointArchive(original, declaration);
    hub.resolveCheckpointArchive(current, { ...declaration, operation_id: randomUUID() });
    expect(await next).toBe(null);
    hub.resolveCheckpointArchive(current, declaration);
    const final = hub.prepareCheckpointArchive(workspaceId, payload);
    hub.resolveCheckpointArchive(current, declaration);
    expect((await final)?.connection).toBe(current);
    expect(current.restoreInstalled).toBe(false);
  } finally {
    first.close();
    second?.close();
    hub.close(workspaceId);
    await server.stop(true);
  }
});
