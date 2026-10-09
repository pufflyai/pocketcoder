import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentFrameSchema, PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { prepareDisposableRuntimeStorage } from "../persistence/disposable-runtime-storage";
import { handleConnectedFrame } from "./ws-frame-handler";

// Real disk PGlite, real archive HTTP service and a real live socket.
test.each(["normal", "expiry", "missing receipt"])(
  "restore readiness settles atomically with %s authority",
  async (authority) => {
    const f = await checkpointHttpFixture();
    let socket: WebSocket | undefined;
    try {
      const preservation = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
      const upload = await f.grant;
      expect((await fetch(upload.url, { method: "PUT", headers: f.headers(upload), body: f.raw })).status).toBe(201);
      await preservation;
      const now = new Date();
      const id = randomUUID();
      const operationId = randomUUID();
      await f.store.insertWorkspace({
        id,
        principalId: f.principal.id,
        externalId: id,
        idempotencyKey: id,
        requestDigest: id,
        templateId: f.template.id,
        templateSnapshot: f.workspace.templateSnapshot,
        launchInput: { task: "in-memory-until-ready" },
        metadata: {},
        deadlineAt: new Date(Date.now() + 30_000),
        createdAt: now,
        originWorkspaceId: f.workspace.id,
        restoredFromCheckpointId: f.checkpoint.id,
        launchMode: "restore",
      });
      await f.store.transition(id, { from: ["queued"], to: "provisioning", at: now });
      await f.store.transition(id, { from: ["provisioning"], to: "connected", at: now });
      await f.store.updateWorkspace(id, { connectionEpoch: 5 }, now);
      const destination = await f.store.getWorkspace(id);
      if (!destination) throw new Error("Destination is missing");
      await prepareDisposableRuntimeStorage(f.store, "docker", destination, now);
      await f.store.insertOperation({
        id: operationId,
        principalId: f.principal.id,
        kind: "restore",
        state: "running",
        idempotencyKey: operationId,
        requestDigest: operationId,
        workspaceId: f.workspace.id,
        checkpointId: f.checkpoint.id,
        resultWorkspaceId: id,
        reasonCode: null,
        attemptCount: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
      const connected = await f.connect(id, 5);
      socket = connected.socket;
      const grant = await f.service.restoreGrant(connected.conn, destination);
      if (!grant) throw new Error("Grant missing");
      const server = buildServer({
        store: f.store,
        driver: new DockerDriver(),
        storageDriver: new FilesystemStorageDriver({
          workspaceRoot: join(f.directory, "..", "live"),
          checkpointRoot: f.directory,
        }),
        checkpointTransferOptions: {
          directory: f.directory,
          agentBaseUrl: () => "http://127.0.0.1:0",
          limits: {
            deadlineMs: 3000,
            maxArchiveBytes: 65536,
            maxIndexBytes: 65536,
            maxQueueBytes: 65536,
            maxLedgerBytes: 65536,
          },
          retentionLimits: {
            maxCheckpointFiles: 100,
            maxRetainedBytes: 1000000,
            maxRetainedBytesPerPrincipal: 1000000,
            maxCheckpointsPerPrincipal: 10,
          },
          readCapacity: () => {
            throw new Error("Readiness cannot reserve upload storage");
          },
        },
        limits: DEFAULT_LIMITS,
        pepper: "readiness-fixture",
        workspaceServerUrl: "http://127.0.0.1:0",
      });
      const deps = {
        ...server,
        store: f.store,
        hub: f.hub,
        pepper: "readiness-fixture",
        checkpointTransfers: f.service,
      };
      let seq = 0;
      async function frame(type: string, payload: unknown) {
        const parsed = AgentFrameSchema.parse({
          v: PROTOCOL_VERSION,
          type,
          workspace_id: id,
          connection_id: connected.conn.connectionId,
          seq: ++seq,
          sent_at: new Date().toISOString(),
          payload,
        });
        await handleConnectedFrame(deps, connected.conn, connected.conn.ws, parsed, (_ws, message) => {
          throw new Error(message);
        });
      }
      await frame("service_health", { service: "agent", health: "healthy" });
      await frame("process_state", { phase: "running" });
      expect((await f.store.getWorkspace(id))?.state).toBe("connected");
      expect((await f.store.getWorkspace(id))?.launchInput).toEqual({ task: "in-memory-until-ready" });
      const installed = {
        operation_id: operationId,
        transfer_id: grant.transfer_id,
        checkpoint_id: f.checkpoint.id,
        archive_digest: grant.source.archive_digest,
        phase: "installed",
      };
      await frame("checkpoint_installed", { ...installed, operation_id: randomUUID() });
      expect(connected.conn.restoreInstalled).toBe(false);
      expect((await f.store.getWorkspaceStorage(id))?.state).toBe("restoring");
      const headers = {
        authorization: `Bearer ${grant.credential}`,
        "x-checkpoint-transfer-id": grant.transfer_id,
        "x-pocketcoder-workspace": id,
        "x-pocketcoder-connection": connected.conn.connectionId,
        "x-pocketcoder-epoch": "5",
        "x-pocketcoder-operation": operationId,
      };
      const response = await fetch(grant.url, { headers });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.raw);
      await frame("process_state", { phase: "running" });
      expect((await f.store.getWorkspace(id))?.state).toBe("connected");
      if (authority !== "normal") connected.conn.harnessRunning = false;
      await frame("checkpoint_installed", installed);
      expect(connected.conn.restoreInstalled).toBe(true);
      if (authority !== "normal") {
        expect((await f.store.getWorkspace(id))?.state).toBe("connected");
        if (authority === "expiry")
          await f.store.updateCheckpoint(f.checkpoint.id, { expiresAt: new Date(Date.now() - 1) }, new Date());
        else
          await f.context.db
            .delete(f.context.tables.checkpointTransfers)
            .where(eq(f.context.tables.checkpointTransfers.id, grant.transfer_id));
        await frame("process_state", { phase: "running" });
        expect(await f.store.getWorkspace(id)).toMatchObject({
          state: "failed",
          readyAt: null,
          launchInput: null,
          registrationDigest: null,
          reconnectDigest: null,
        });
        expect(await f.store.getOperation(operationId)).toMatchObject({
          state: "failed",
          reasonCode: "restore_failed",
        });
        expect((await f.store.listStateHistory(id)).some((entry) => entry.toState === "ready")).toBe(false);
        expect((await f.store.listWorkspaceStorage(id))[0]?.state).toBe("deleted");
        expect(f.hub.get(id)).toBeUndefined();
        expect((await f.store.checkpointTransfers.get(grant.transfer_id))?.grantDigest ?? null).toBeNull();
        await frame("process_state", { phase: "running" });
        socket.close();
        expect((await f.store.getWorkspace(id))?.state).toBe("failed");
        expect((await f.store.getOperation(operationId))?.state).toBe("failed");
        await server.scheduler.drain();
        await server.checkpointTransfers?.close();
        return;
      }
      expect((await f.store.getWorkspace(id))?.state).toBe("ready");
      await frame("process_state", { phase: "running" });
      expect((await f.store.getWorkspace(id))?.state).toBe("ready");
      expect((await f.store.getWorkspace(id))?.launchInput).toBe(null);
      expect((await f.store.getOperation(operationId))?.state).toBe("succeeded");
      expect((await f.store.getWorkspaceStorage(id))?.state).toBe("ready");
      f.hub.close(id);
      await server.checkpointTransfers?.close();
    } finally {
      socket?.close();
      await f.dispose();
    }
  },
);
