import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_ARCHIVE_FORMAT,
  PROTOCOL_VERSION,
  snapshotOf,
  writeCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { WSContext } from "hono/ws";
import { Hub } from "../control-channel/hub";
import { createCheckpointTransferService } from "./checkpoint-transfer";
import { prepareDisposableRuntimeStorage } from "./disposable-runtime-storage";

async function source(f: Awaited<ReturnType<typeof createPGliteFixture>>, content?: Uint8Array) {
  const workspace = await insertTestWorkspace(f, "source");
  const now = new Date();
  await f.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at: now });
  await f.store.transition(workspace.id, { from: ["provisioning"], to: "connected", at: now });
  await f.store.transition(workspace.id, { from: ["connected"], to: "preserving", at: now });
  await f.store.updateWorkspace(workspace.id, { connectionEpoch: 3 }, now);
  const storageId = randomUUID();
  await f.store.insertWorkspaceStorage({
    id: storageId,
    workspaceId: workspace.id,
    principalId: workspace.principalId,
    providerKind: "disposable",
    providerRef: {},
    state: "ready",
    mountManifest: f.parsed.manifest.spec.persistence.mounts,
    logicalBytes: null,
    fileCount: null,
    retainedUntil: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    lastErrorCode: null,
  });
  const checkpoint = await f.store.insertCheckpoint({
    id: randomUUID(),
    workspaceId: workspace.id,
    principalId: workspace.principalId,
    storageId,
    parentCheckpointId: null,
    state: "creating",
    reasonCode: null,
    providerKind: "controller-archive",
    providerRef: null,
    templateSnapshot: snapshotOf(f.parsed),
    templateDigest: f.parsed.digest,
    sourceProvenance: null,
    manifest: null,
    manifestDigest: null,
    logicalBytes: null,
    storedBytes: null,
    fileCount: null,
    conversationRestore: "filesystem_only",
    label: null,
    createdAt: now,
    updatedAt: now,
    readyAt: null,
    expiresAt: null,
    deletedAt: null,
  });
  const operationId = randomUUID();
  await f.store.insertOperation({
    id: operationId,
    principalId: workspace.principalId,
    kind: "preserve",
    state: "running",
    idempotencyKey: operationId,
    requestDigest: operationId,
    workspaceId: workspace.id,
    checkpointId: checkpoint.id,
    resultWorkspaceId: null,
    reasonCode: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  const header = {
    format: CHECKPOINT_ARCHIVE_FORMAT as typeof CHECKPOINT_ARCHIVE_FORMAT,
    checkpoint_id: checkpoint.id,
    workspace_id: workspace.id,
    template_digest: f.parsed.digest,
    mounts: [{ name: "worktree", logical_bytes: content?.length ?? 0, file_count: content ? 1 : 0 }],
  };
  async function* records() {
    if (content)
      yield {
        entry: {
          mount: 0,
          path: "tiny",
          kind: "file" as const,
          size: content.length,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          mode: 0o600,
          mtime_ns: "1",
        },
        payload: new Blob([content]).stream(),
      };
  }
  const raw = Buffer.from(
    await new Response(writeCheckpointArchive(header, records(), { maxArchiveBytes: 65536 })).arrayBuffer(),
  );
  return { workspace, checkpoint, operationId, header, raw };
}

export async function checkpointHttpFixture(content?: Uint8Array) {
  const disk = await realpath(await mkdtemp(join(tmpdir(), "pc-transfer-http-")));
  const f = await createPGliteFixture("pc-transfer-http-db", "disk");
  const directory = join(disk, "archives");
  await mkdir(directory, { mode: 0o700 });
  const { workspace, checkpoint, operationId, header, raw } = await source(f, content);
  const hub = new Hub();
  let grantResolve!: (payload: { credential: string; transfer_id: string; url: string }) => void;
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const grant = new Promise<{ credential: string; transfer_id: string; url: string }>((resolve) => {
    grantResolve = resolve;
  });
  const server = Bun.serve<{ workspaceId: string; epoch: number }>({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/connect") {
        if (
          server.upgrade(request, {
            data: {
              workspaceId: new URL(request.url).searchParams.get("workspace") ?? workspace.id,
              epoch: Number(new URL(request.url).searchParams.get("epoch") ?? 3),
            },
          })
        )
          return;
        return new Response(null, { status: 426 });
      }
      const id = new URL(request.url).pathname.split("/")[4] ?? "";
      return request.method === "PUT" ? service.handleUpload(request, id) : service.handleDownload(request, id);
    },
    websocket: {
      open(ws) {
        const conn = hub.attach(
          ws.data.workspaceId,
          randomUUID(),
          ws.data.epoch,
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
        conn.registered = true;
        connected();
      },
      message(_ws, raw) {
        const conn = hub.get(_ws.data.workspaceId);
        if (conn) hub.resolveCheckpointArchive(conn, JSON.parse(String(raw)));
      },
    },
  });
  const service = createCheckpointTransferService({
    store: f.store,
    hub,
    directory,
    agentBaseUrl: () => `http://127.0.0.1:${server.port}`,
    retentionLimits: {
      maxCheckpointFiles: 100,
      maxRetainedBytes: 1_000_000,
      maxRetainedBytesPerPrincipal: 1_000_000,
      maxCheckpointsPerPrincipal: 10,
    },
    limits: {
      deadlineMs: 3000,
      maxArchiveBytes: 65536,
      maxIndexBytes: 65536,
      maxQueueBytes: 65536,
      maxLedgerBytes: 65536,
    },
    readCapacity: () => ({
      workspace: { bytes: 1_000_000, files: 100 },
      principal: { bytes: 1_000_000, files: 100 },
      instance: { bytes: 1_000_000, files: 100 },
      freeDisk: { bytes: 2_000_000, files: 200, headroomBytes: 1_000_000, headroomFiles: 100 },
    }),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/connect`);
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "prepare_checkpoint_archive")
      socket.send(
        JSON.stringify({ operation_id: operationId, checkpoint_id: checkpoint.id, header, archive_bytes: raw.length }),
      );
    if (frame.type === "checkpoint_upload") grantResolve(frame.payload);
  };
  await ready;
  const current = await f.store.getWorkspace(workspace.id);
  expect(current).not.toBeNull();
  if (!current) throw new Error("source workspace missing");
  return {
    ...f,
    workspace: current,
    checkpoint,
    operationId,
    raw,
    header,
    hub,
    service,
    directory,
    socket,
    grant,
    async connect(id: string, epoch: number) {
      const destination = await f.store.getWorkspace(id);
      if (destination?.launchMode === "restore" && !(await f.store.getWorkspaceStorage(id)))
        await prepareDisposableRuntimeStorage(f.store, "docker", destination, new Date());
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/connect?workspace=${id}&epoch=${epoch}`);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = reject;
      });
      const conn = hub.get(id);
      if (!conn) throw new Error("destination connection missing");
      return { socket, conn };
    },
    headers(grant: { credential: string; transfer_id: string }, operation: string = operationId) {
      const conn = hub.get(workspace.id);
      if (!conn) throw new Error("source connection missing");
      return {
        authorization: `Bearer ${grant.credential}`,
        "x-checkpoint-transfer-id": grant.transfer_id,
        "x-pocketcoder-workspace": workspace.id,
        "x-pocketcoder-connection": conn.connectionId,
        "x-pocketcoder-epoch": String(conn.epoch),
        "x-pocketcoder-operation": operation,
      };
    },
    async dispose() {
      await service.close();
      socket.close();
      hub.close(workspace.id);
      await server.stop(true);
      await f.dispose();
      await rm(disk, { recursive: true, force: true });
    },
  };
}
