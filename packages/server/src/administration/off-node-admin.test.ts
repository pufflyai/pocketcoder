import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig, OffNodeBackupReceiptSchema } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createControllerBackup } from "../backup/controller-backup";
import { createOffNodeBackup } from "../backup/off-node-backup";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { startLocalAdmin } from "./local-admin";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "private off-node admission retains a real filesystem failure for the operator without publishing an archive",
  async () => {
    const remote = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-private-backup-"));
    let controller: Awaited<ReturnType<typeof openControllerStore>> | undefined;
    let admin: Awaited<ReturnType<typeof startLocalAdmin>> | undefined;
    try {
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const config = join(root, "config.json");
      const accountId = randomUUID();
      await writeFile(config, JSON.stringify({ accountId, storage: remote.config, encryptionKeyFile: key }), {
        mode: 0o600,
      });
      const offNode = await loadOffNodeConfig(config);
      const directory = join(root, "source");
      controller = await openControllerStore(directory, undefined, { acknowledgeJournal: offNode.journal.acknowledge });
      const checkpoints = join(root, "checkpoint-folder");
      await writeFile(checkpoints, "This is a file, so source inventory must fail.");
      const backup = createControllerBackup({
        store: controller.store,
        maintenance: createMaintenance(),
        keys: controller.keys,
        checkpointDirectory: checkpoints,
      });
      admin = await startLocalAdmin({
        directory,
        store: controller.store,
        pepper: controller.keys.pepper,
        backup,
        offNodeBackup: createOffNodeBackup({
          store: controller.store,
          offNode,
          backup,
        }),
      });
      const operation = randomUUID();
      const response = await fetch("http://localhost/v1/backup/off-node", {
        unix: admin.path,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation_id: operation }),
      });
      expect(response.status).toBe(409);
      const result = (await response.json()) as { error: { code: string; message: string } };
      expect(result.error.code).toBe("backup.failed");
      expect(result.error.message).toContain("ENOTDIR");
      expect(await remote.storage.versions(`accounts/${accountId}/backups/${operation}/`)).toHaveLength(0);
      await rm(checkpoints);
      await mkdir(checkpoints, { mode: 0o700 });
      const retried = await fetch("http://localhost/v1/backup/off-node", {
        unix: admin.path,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation_id: operation }),
      });
      expect(retried.status).toBe(201);
      const receipt = OffNodeBackupReceiptSchema.parse(await retried.json());
      expect(receipt).toMatchObject({ accountId, operationId: operation });
      expect(await remote.storage.versions(`accounts/${accountId}/backups/${operation}/`)).toHaveLength(1);
    } finally {
      await admin?.stop();
      await controller?.store.close();
      await remote.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
