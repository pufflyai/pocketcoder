import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { WorkspaceService } from "../workspaces/service";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";
import { PersistenceService } from "./persistence";

test("scheduler deadline preserve publishes after workload expiry and settles owned storage", async () => {
  const f = await checkpointHttpFixture(Buffer.from("x"));
  let persistence: PersistenceService | undefined;
  let upload: Promise<Response> | undefined;
  let grant:
    | { credential: string; transfer_id: string; url: string; operation_id: string; expires_at: string }
    | undefined;
  let archive = Buffer.alloc(0);
  try {
    await f.store.updateOperation(f.operationId, { state: "failed" }, new Date());
    await f.store.updateCheckpoint(f.checkpoint.id, { state: "failed" }, new Date());
    const deadline = new Date(Date.now() - 1000);
    await f.query(
      `UPDATE "${f.schema}"."workspaces" SET state='ready', deadline_at=$1, template_snapshot=jsonb_set(template_snapshot, '{spec,persistence,checkpoint,onDeadline}', '"preserve"') WHERE id=$2`,
      [deadline, f.workspace.id],
    );
    const driver = new DockerDriver({ inputDir: join(f.directory, "inputs") });
    const storageDriver = new FilesystemStorageDriver({
      workspaceRoot: join(f.directory, "..", "workspaces"),
      checkpointRoot: f.directory,
    });
    const scheduler = new Scheduler({
      store: f.store,
      driver,
      storageDriver,
      connections: f.hub,
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1",
      secrets: {
        generate: () => randomBytes(32).toString("base64url"),
        digest: (value) => createHash("sha256").update(value).digest(),
      },
      preserveByPolicy: (row, trigger) => {
        if (!persistence) throw new Error("persistence not composed");
        return persistence.preserveByPolicy(row, trigger);
      },
    });
    const workspaces = new WorkspaceService({ store: f.store, scheduler, limits: DEFAULT_LIMITS });
    persistence = new PersistenceService({
      store: f.store,
      driver,
      storageDriver,
      scheduler,
      hub: f.hub,
      workspaces,
      checkpointTransfers: f.service,
      maxQueuedWorkspaces: DEFAULT_LIMITS.maxQueuedWorkspaces,
    });
    f.socket.onmessage = async (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "prepare_checkpoint_archive") {
        const header = { ...f.header, checkpoint_id: frame.payload.checkpoint_id };
        async function* records() {
          const content = Buffer.from("x");
          yield {
            entry: {
              mount: 0,
              path: "tiny",
              kind: "file" as const,
              size: 1,
              digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
              mode: 0o600,
              mtime_ns: "1",
            },
            payload: new Blob([content]).stream(),
          };
        }
        archive = Buffer.from(
          await new Response(writeCheckpointArchive(header, records(), { maxArchiveBytes: 65536 })).arrayBuffer(),
        );
        f.socket.send(
          JSON.stringify({
            operation_id: frame.payload.operation_id,
            checkpoint_id: frame.payload.checkpoint_id,
            header,
            archive_bytes: archive.length,
          }),
        );
      }
      if (frame.type === "checkpoint_upload") {
        grant = frame.payload;
        if (!grant) throw new Error("upload grant missing");
        upload = fetch(grant.url, { method: "PUT", headers: f.headers(grant, grant.operation_id), body: archive });
      }
    };
    await scheduler.sweep();
    await persistence.drain();
    expect(grant).toBeDefined();
    if (!grant || !upload) throw new Error("deadline policy did not reach upload");
    expect((await upload).status).toBe(201);
    const operation = await f.store.getOperation(grant.operation_id);
    expect(operation).toMatchObject({ state: "succeeded", reasonCode: "preserved_by_policy" });
    if (!operation?.checkpointId) throw new Error("policy checkpoint missing");
    const checkpoint = await f.store.getCheckpoint(operation.checkpointId);
    expect(checkpoint?.state).toBe("ready");
    expect(checkpoint?.readyAt?.getTime()).toBeGreaterThan(deadline.getTime());
    expect(new Date(grant.expires_at).getTime()).toBeLessThanOrEqual(operation.createdAt.getTime() + 3000);
    expect(new Date(grant.expires_at).getTime()).toBeGreaterThan(deadline.getTime());
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("preserved");
    expect((await f.store.listWorkspaceStorage(f.workspace.id))[0]?.state).toBe("deleted");
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    expect(transfer?.state).toBe("complete");
    const reservation = await f.store.storageReservations.get(transfer?.reservationId ?? "");
    expect(reservation?.state).toBe("committed");
    expect(reservation?.reservedBytes).toBe(Number(transfer?.stageIdentity?.allocatedBytes));
    expect(reservation?.materializedBytes).toBe(reservation?.reservedBytes);
    if (!transfer?.stagePath) throw new Error("durable archive missing");
    expect(await readFile(join(f.directory, transfer.stagePath))).toEqual(archive);
    expect(await readdir(f.directory)).toEqual([transfer.stagePath]);
  } finally {
    await persistence?.drain();
    await f.dispose();
  }
});
