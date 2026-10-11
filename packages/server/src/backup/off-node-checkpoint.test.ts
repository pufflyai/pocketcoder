import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { loadOffNodeConfig, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { Hub } from "../control-channel/hub";
import { createMaintenance } from "../maintenance/maintenance";
import { createCheckpointTransferService } from "../persistence/checkpoint-transfer";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { createControllerBackup } from "./controller-backup";
import { pauseBefore } from "./crash-process";
import { createOffNodeBackup } from "./off-node-backup";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "fresh off-node checkpoint publication keeps exact custody for later deletion replay",
  async () => {
    const remote = await objectStorageFixture();
    const f = await checkpointHttpFixture(new TextEncoder().encode("deleted after capture"));
    const root = await mkdtemp(join(tmpdir(), "pc93-checkpoint-copy-"));
    let restored: PGliteStore | undefined;
    let service: ReturnType<typeof createCheckpointTransferService> | undefined;
    try {
      const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
      const grant = await f.grant;
      expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
      const checkpoint = await pending;
      await f.store.transition(f.workspace.id, { from: ["preserving"], to: "preserved", at: new Date() });
      await f.store.updateOperation(f.operationId, { state: "succeeded", completedAt: new Date() }, new Date());
      await f.service.verify(checkpoint);
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const config = join(root, "off-node.json");
      await writeFile(
        config,
        JSON.stringify({ accountId: randomUUID(), storage: remote.config, encryptionKeyFile: key }),
        { mode: 0o600 },
      );
      const offNode = await loadOffNodeConfig(config);
      await offNode.journal.acknowledge(f.store.journalSnapshot());
      const receipt = await createOffNodeBackup({
        store: f.store,
        offNode,
        backup: createControllerBackup({
          store: f.store,
          maintenance: createMaintenance(),
          checkpointDirectory: f.directory,
          keys: {
            pepper: randomBytes(32).toString("base64url"),
            eventSigningKey: randomBytes(32).toString("base64url"),
            secretKey: randomBytes(32).toString("base64url"),
          },
        }),
      })(randomUUID(), new AbortController().signal);
      const id = randomUUID();
      const deletion = {
        id,
        principalId: checkpoint.principalId,
        kind: "delete" as const,
        state: "pending" as const,
        idempotencyKey: id,
        requestDigest: id,
        workspaceId: checkpoint.workspaceId,
        checkpointId: checkpoint.id,
        resultWorkspaceId: null,
        reasonCode: null,
        attemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      };
      await f.store.insertOperation(deletion);
      await f.service.delete(checkpoint);
      await f.store.updateCheckpoint(checkpoint.id, { state: "deleted", deletedAt: new Date() }, new Date());
      await f.store.updateOperation(id, { state: "succeeded", completedAt: new Date() }, new Date());
      expect(await readdir(f.directory)).toEqual([]);
      await offNode.journal.acknowledge(f.store.journalSnapshot());
      const input = {
        operationId: randomUUID(),
        receipt,
        offNode,
        dataDir: join(root, "fresh"),
        checkpointDir: join(root, "checkpoints"),
        journalDir: join(root, "journal"),
      };
      await restoreOffNodeBackup(input);
      restored = await PGliteStore.create(input.dataDir, {
        journalDir: input.journalDir,
        acknowledgeJournal: offNode.journal.acknowledge,
      });
      await offNode.journal.transfer(restored.journalSnapshot(), receipt.sourceWriter);
      for (const event of await restored.recovery.recoveryEvents()) await restored.recovery.applyRecord(event);
      const copied = await restored.getCheckpoint(checkpoint.id);
      if (!copied) throw new Error("Restored checkpoint metadata is missing.");
      service = createCheckpointTransferService({
        store: restored,
        hub: new Hub(),
        directory: input.checkpointDir,
        agentBaseUrl: "http://127.0.0.1:1",
        limits: {
          deadlineMs: 3000,
          maxArchiveBytes: 65536,
          maxIndexBytes: 65536,
          maxQueueBytes: 65536,
          maxLedgerBytes: 65536,
        },
        retentionLimits: {
          maxCheckpointFiles: 100,
          maxRetainedBytes: 1_000_000,
          maxRetainedBytesPerPrincipal: 1_000_000,
          maxCheckpointsPerPrincipal: 10,
        },
        readCapacity: () => ({
          workspace: { bytes: 1_000_000, files: 100 },
          principal: { bytes: 1_000_000, files: 100 },
          instance: { bytes: 1_000_000, files: 100 },
          freeDisk: { bytes: 2_000_000, files: 200, headroomBytes: 1_000_000, headroomFiles: 100 },
        }),
      });
      const publication = await restored.checkpointTransfers.publication(checkpoint.id);
      if (!publication?.stagePath || !publication.stageIdentity)
        throw new Error("Restored publication receipt is missing.");
      const actual = await stat(join(input.checkpointDir, publication.stagePath), { bigint: true });
      console.log(
        JSON.stringify({
          copiedCheckpoint: checkpoint.id,
          recorded: publication.stageIdentity,
          actual: { inode: String(actual.ino), ctimeNs: String(actual.ctimeNs), links: String(actual.nlink) },
        }),
      );
      expect(String(actual.ino)).toBe(publication.stageIdentity.inode);
      expect(actual.nlink).toBe(1n);
      await service.verify(copied);
      await restored.insertOperation({ ...deletion, id: randomUUID(), idempotencyKey: `replay:${id}` });
      await service.delete(copied);
      expect(await readdir(input.checkpointDir)).toEqual([]);
      await restored.close();
      restored = undefined;
      expect(await restoreOffNodeBackup(input)).toBeDefined();
      const replacement = {
        ...input,
        operationId: randomUUID(),
        dataDir: join(root, "replacement-data"),
        checkpointDir: join(root, "replacement-checkpoints"),
        journalDir: join(root, "replacement-journal"),
      };
      const paused = await pauseBefore(
        { kind: "restore", path: config, input: { ...replacement, offNode: undefined } },
        "packages/db/src/off-node/restore.ts",
        "await publishRestoreCheckpoints(staging, manifest)",
        "await reconcileRestoredPublications",
      );
      try {
        const name = (await readdir(replacement.checkpointDir))[0] as string;
        const path = join(replacement.checkpointDir, name);
        const original = await stat(path);
        const bytes = await readFile(path);
        const changed = join(root, "replacement.tar");
        await writeFile(changed, bytes, { mode: 0o600 });
        await rename(changed, path);
        expect((await stat(path)).ino).not.toBe(original.ino);
        expect(await readFile(path)).toEqual(bytes);
      } finally {
        await paused.kill();
      }
      await expect(restoreOffNodeBackup(replacement)).rejects.toThrow("publication custody differs");
    } finally {
      const cleanup = await Promise.allSettled([
        service?.close(),
        restored?.close(),
        f.dispose(),
        remote.close(),
        rm(root, { recursive: true, force: true }),
      ]);
      for (const result of cleanup)
        if (result.status === "rejected") console.error("Checkpoint copy cleanup failed", result.reason);
    }
  },
  60_000,
);
