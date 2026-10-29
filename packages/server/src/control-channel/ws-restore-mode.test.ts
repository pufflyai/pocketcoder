import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { digestOpaque } from "@pstdio/pocketcoder-auth";
import {
  HEADER_PROTOCOL,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
  ServerFrameSchema,
} from "@pstdio/pocketcoder-contracts";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";

test.each(["provider_installed", "controller_archive"])(
  "server composition explicitly delivers %s restore",
  async (mode) => {
    const f = await checkpointHttpFixture();
    const id = randomUUID();
    const operationId = randomUUID();
    const registration = "single-use-registration";
    const pepper = "restore-mode-fixture";
    let baseUrl = "";
    const controller = buildServer({
      store: f.store,
      driver: new DockerDriver({ inputDir: join(f.directory, "inputs") }),
      limits: DEFAULT_LIMITS,
      pepper,
      workspaceServerUrl: "http://127.0.0.1:0",
      ...(mode === "controller_archive"
        ? {
            storageDriver: new FilesystemStorageDriver({
              workspaceRoot: join(f.directory, "..", "workspaces"),
              checkpointRoot: f.directory,
            }),
            checkpointTransferOptions: {
              directory: f.directory,
              agentBaseUrl: () => baseUrl,
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
                throw new Error("Destination must not upload");
              },
            },
          }
        : {}),
    });
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: controller.agentApp.fetch,
      websocket: controller.websocket,
    });
    baseUrl = listener.url.toString();
    let socket: WebSocket | undefined;
    try {
      const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
      const upload = await f.grant;
      expect((await fetch(upload.url, { method: "PUT", headers: f.headers(upload), body: f.raw })).status).toBe(201);
      await pending;
      const at = new Date();
      await f.store.insertWorkspace({
        id,
        principalId: f.principal.id,
        externalId: id,
        idempotencyKey: id,
        requestDigest: id,
        templateId: f.template.id,
        templateSnapshot: f.workspace.templateSnapshot,
        launchInput: null,
        metadata: {},
        deadlineAt: new Date(Date.now() + 30000),
        createdAt: at,
        originWorkspaceId: f.workspace.id,
        restoredFromCheckpointId: f.checkpoint.id,
        launchMode: "restore",
      });
      await f.store.transition(id, { from: ["queued"], to: "provisioning", at });
      await f.store.updateWorkspace(
        id,
        { registrationDigest: digestOpaque(pepper, registration), registrationExpiresAt: new Date(Date.now() + 30000) },
        at,
      );
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
        createdAt: at,
        updatedAt: at,
        completedAt: null,
      });
      socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}v1/agent/connect`, {
        headers: {
          [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
          [HEADER_WORKSPACE]: id,
          [HEADER_REGISTRATION]: registration,
        },
      } as unknown as string[]);
      const connectedSocket = socket;
      const ack = await new Promise<ReturnType<typeof ServerFrameSchema.parse>>((resolveAck, reject) => {
        const timer = setTimeout(() => reject(new Error("Registration timed out")), 2000);
        connectedSocket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Registration failed"));
        };
        connectedSocket.onclose = () => {
          clearTimeout(timer);
          reject(new Error("Registration closed"));
        };
        connectedSocket.onopen = () =>
          connectedSocket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "registered",
              workspace_id: id,
              connection_id: randomUUID(),
              seq: 0,
              sent_at: at.toISOString(),
              payload: {
                agent_version: "restore-mode-test",
                template: { name: "restore", version: "1.0.0", digest: f.header.template_digest },
                services: [],
                pid: 1,
              },
            }),
          );
        connectedSocket.onmessage = (event) => {
          clearTimeout(timer);
          try {
            resolveAck(ServerFrameSchema.parse(JSON.parse(String(event.data))));
          } catch (error) {
            reject(error);
          }
        };
      });
      if (ack.type !== "registered_ack") throw new Error("Registration ack missing");
      expect(ack.payload.exec.restore).toMatchObject({
        mode,
        checkpoint_id: f.checkpoint.id,
        origin_workspace_id: f.workspace.id,
      });
      const grant = ack.payload.exec.restore?.transfer;
      if (mode === "provider_installed") expect(grant).toBeNull();
      else {
        expect(grant?.operation_id).toBe(operationId);
        const connection = controller.hub.get(id);
        expect(grant).toBeDefined();
        expect(connection).toBeDefined();
        if (!grant || !connection) throw new Error("Fresh transfer missing");
        const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
        expect(transfer?.connectionEpoch).toBe(connection.epoch);
        expect(transfer?.workspaceId).toBe(id);
        const headers: Record<string, string> = {
          authorization: `Bearer ${grant.credential}`,
          "x-checkpoint-transfer-id": grant.transfer_id,
          "x-pocketcoder-workspace": id,
          "x-pocketcoder-operation": operationId,
          "x-pocketcoder-epoch": String(connection.epoch),
          "x-pocketcoder-connection": randomUUID(),
        };
        expect((await fetch(grant.url, { headers })).status).toBe(401);
        headers["x-pocketcoder-connection"] = connection.connectionId;
        const download = await fetch(grant.url, { headers });
        expect(download.status).toBe(200);
        expect(Buffer.from(await download.arrayBuffer())).toEqual(f.raw);
        expect((await f.store.getOperation(operationId))?.state).toBe("running");
      }
    } finally {
      socket?.close();
      await listener.stop(true);
      await controller.checkpointTransfers?.close();
      await controller.scheduler.drain();
      await f.dispose();
    }
  },
);
