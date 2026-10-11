import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "a completed encrypted backup survives controller restart without another snapshot or upload",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-backup-"));
    let controller: Awaited<ReturnType<typeof openControllerStore>> | undefined;
    try {
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const config = join(root, "off-node.json");
      const accountId = randomUUID();
      await writeFile(config, JSON.stringify({ accountId, storage: fixture.config, encryptionKeyFile: key }), {
        mode: 0o600,
      });
      const offNode = await loadOffNodeConfig(config);
      controller = await openControllerStore(join(root, "source"), undefined, {
        acknowledgeJournal: offNode.journal.acknowledge,
      });
      const maintenance = createMaintenance();
      const capture = createControllerBackup({ store: controller.store, maintenance, keys: controller.keys });
      const backup = createOffNodeBackup({ store: controller.store, offNode, backup: capture });
      const id = randomUUID();
      const receipt = await backup(id, new AbortController().signal);
      const prefix = `accounts/${accountId}/backups/${id}/`;
      const versions = await fixture.storage.versions(prefix);
      expect(versions).toHaveLength(1);
      expect(receipt.object).toMatchObject({ key: `${prefix}backup.enc`, versionId: versions[0]?.versionId });
      const bytes = Buffer.from(
        await (await fixture.storage.get(receipt.object.key, receipt.object.versionId)).arrayBuffer(),
      );
      expect(bytes.includes(Buffer.from("pocketcoder-backup"))).toBe(false);
      expect(bytes.includes(Buffer.from(controller.keys.secretKey))).toBe(false);
      await controller.store.close();
      controller = await openControllerStore(join(root, "source"), undefined, {
        acknowledgeJournal: offNode.journal.acknowledge,
      });
      const fenced = createMaintenance();
      fenced.fence();
      const replay = createOffNodeBackup({
        store: controller.store,
        offNode,
        backup: createControllerBackup({ store: controller.store, maintenance: fenced, keys: controller.keys }),
      });
      expect(await replay(id, new AbortController().signal)).toEqual(receipt);
      expect(await fixture.storage.versions(prefix)).toEqual(versions);
      await expect(replay(randomUUID(), new AbortController().signal)).rejects.toMatchObject({
        code: "maintenance.active",
      });
    } finally {
      await controller?.store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
