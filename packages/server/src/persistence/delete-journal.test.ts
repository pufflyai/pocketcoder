import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { loadConfig } from "../config/config";
import { checkpointTransferOptions } from "../lifecycle/checkpoint-transfer-config";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

test("checkpoint deletion is enforced during remote outage and its worker waits across restart", async () => {
  const f = await checkpointHttpFixture(new TextEncoder().encode("bytes that must stay pending"));
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
  const unavailable = endpoint.url.toString();
  await endpoint.stop(true);
  let store = f.store;
  const dataDir = f.context.dataDir;
  if (!dataDir) throw new Error("Disk data directory missing.");
  const build = (current: PGliteStore) =>
    buildServer({
      store: current,
      driver: new DockerDriver(),
      storageDriver: new FilesystemStorageDriver({
        workspaceRoot: join(dirname(f.directory), "workspaces"),
        checkpointRoot: f.directory,
      }),
      pepper: "delete-journal",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:0",
      checkpointTransferOptions: checkpointTransferOptions({
        ...loadConfig(),
        storageBackend: "controller-archive",
        checkpointDir: f.directory,
      }),
    });
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const grant = await f.grant;
    expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
    const checkpoint = await pending;
    const archivePath = checkpoint.providerRef?.archivePath;
    if (typeof archivePath !== "string") throw new Error("Archive path missing.");
    const pepper = "delete-journal";
    const key = issueMachineKey(pepper);
    await store.insertMachineKey({
      id: key.id,
      principalId: f.principal.id,
      secretDigest: key.secretDigest,
      scopes: ["checkpoints:delete", "checkpoints:read", "workspaces:restore"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await f.service.close();
    let original: string | undefined;
    for (let restart = 0; restart < 2; restart++) {
      await store.close();
      store = await PGliteStore.create(dataDir, {
        acknowledgeJournal: async () => {
          await fetch(unavailable);
        },
      });
      const built = build(store);
      try {
        const response = await built.app.request(`/v1/checkpoints/${checkpoint.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key.token}`, "idempotency-key": "delete" },
        });
        expect(response.status).toBe(503);
        const operation = await store.getOperationByIdempotency(f.principal.id, "delete", "delete");
        expect(operation).not.toBeNull();
        original ??= operation?.id;
        expect(operation?.id).toBe(original);
        expect((await store.getCheckpoint(checkpoint.id))?.state).toBe("deleting");
        const restore = await built.app.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.token}`,
            "idempotency-key": `restore-${restart}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ external_id: `restore-${restart}` }),
        });
        expect(await restore.json()).toMatchObject({ error: { code: "checkpoint.not_ready" } });
        if (!operation) throw new Error("Delete intent missing.");
        await expect(built.persistence.reconcileCheckpointOperation(operation)).rejects.toMatchObject({
          code: "journal.pending",
        });
        expect((await store.getOperation(original as string))?.completedAt).toBeNull();
        expect(await readdir(f.directory)).toContain(archivePath);
      } finally {
        await built.checkpointTransfers?.close();
        await built.scheduler.drain();
        await built.persistence.drain();
      }
    }
    await store.close();
    const acknowledgement = join(dirname(f.directory), "ack.json");
    store = await PGliteStore.create(dataDir, {
      acknowledgeJournal: (snapshot) => writePrivateJson(acknowledgement, snapshot.head),
    });
    const built = build(store);
    try {
      const operation = await store.getOperation(original as string);
      if (!operation) throw new Error("Original delete operation missing.");
      expect(await built.persistence.reconcileCheckpointOperation(operation)).toBe(true);
      expect(await store.getOperation(operation.id)).toMatchObject({ state: "succeeded" });
      expect((await store.getCheckpoint(checkpoint.id))?.state).toBe("deleted");
      expect(await readdir(f.directory)).not.toContain(archivePath);
      expect(await Bun.file(acknowledgement).json()).toEqual(store.journalSnapshot().head);
    } finally {
      await built.checkpointTransfers?.close();
      await built.scheduler.drain();
      await built.persistence.drain();
    }
  } finally {
    await store.close();
    await f.dispose();
  }
}, 20_000);
