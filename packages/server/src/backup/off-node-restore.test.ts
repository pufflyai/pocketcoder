import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { loadOffNodeConfig, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { bootstrapLocalOwnerKey } from "@pstdio/pocketcoder-runtime-core";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "a fresh volume uses the current remote journal after the original data and journal are gone",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-restore-"));
    let source: PGliteStore | undefined;
    let restored: PGliteStore | undefined;
    try {
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const config = join(root, "off-node.json");
      const accountId = randomUUID();
      await writeFile(config, JSON.stringify({ accountId, storage: fixture.config, encryptionKeyFile: key }), {
        mode: 0o600,
      });
      const offNode = await loadOffNodeConfig(config);
      const controller = await openControllerStore(join(root, "source"), undefined, {
        acknowledgeJournal: offNode.journal.acknowledge,
      });
      source = controller.store;
      const owner = await bootstrapLocalOwnerKey(source, controller.keys.pepper, {
        request_id: "owner",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const backup = createOffNodeBackup({
        store: source,
        offNode,
        backup: createControllerBackup({ store: source, keys: controller.keys, maintenance: createMaintenance() }),
      });
      const receipt = await backup(randomUUID(), new AbortController().signal);
      await source.revokeMachineKey(owner.key.id, new Date());
      const current = source.journalSnapshot();
      await source.close();
      source = undefined;
      await rm(join(root, "source"), { recursive: true });
      await rm(join(root, "source-journal"), { recursive: true });
      const input = {
        operationId: randomUUID(),
        receipt,
        offNode,
        dataDir: join(root, "fresh"),
        journalDir: join(root, "fresh-journal"),
        checkpointDir: join(root, "fresh-checkpoints"),
      };
      const result = await restoreOffNodeBackup(input);
      restored = await PGliteStore.create(input.dataDir, {
        journalDir: input.journalDir,
        acknowledgeJournal: offNode.journal.acknowledge,
      });
      expect((await restored.recovery.recoveryState())?.snapshotId).toBe(receipt.snapshotId);
      expect(restored.journalSnapshot().head).toEqual(current.head);
      expect((await restored.getMachineKeyWithPrincipal(owner.key.id))?.key.revokedAt).toBeNull();
      await expect(restored.recovery.finishRecovery(result.recovery.recoveryId)).rejects.toMatchObject({
        code: "journal.pending",
      });
      for (const event of await restored.recovery.recoveryEvents()) await restored.recovery.applyRecord(event);
      expect((await restored.getMachineKeyWithPrincipal(owner.key.id))?.key.revokedAt).not.toBeNull();
      await offNode.journal.transfer(restored.journalSnapshot(), receipt.sourceWriter);
      await restored.recovery.finishRecovery(result.recovery.recoveryId);
      expect(await restored.recovery.recoveryState()).toBeNull();
      await restored.close();
      restored = undefined;
      const versions = await fixture.storage.versions(`accounts/${accountId}/`);
      expect(await restoreOffNodeBackup(input)).toEqual(result);
      expect(await fixture.storage.versions(`accounts/${accountId}/`)).toEqual(versions);
      expect(await Bun.file(join(input.dataDir, "account-lifecycle.json")).json()).toMatchObject({
        state: "suspended",
      });
    } finally {
      await restored?.close();
      await source?.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
