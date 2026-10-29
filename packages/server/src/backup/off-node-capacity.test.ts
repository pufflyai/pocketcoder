import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

const enabled = process.env.RUN_S3_INTEGRATION === "1";
const policies = [
  { dimension: "bytes", staging: { maxBytes: 1024, maxFiles: 1_000_000 } },
  { dimension: "inodes", staging: { maxBytes: 4 * 1024 ** 3, maxFiles: 1 } },
];

async function fixture() {
  const remote = await objectStorageFixture();
  const root = await mkdtemp(join(tmpdir(), "pc93-capacity-"));
  const key = join(root, "outer-key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const path = join(root, "off-node.json");
  await writeFile(path, JSON.stringify({ accountId: randomUUID(), storage: remote.config, encryptionKeyFile: key }), {
    mode: 0o600,
  });
  const offNode = await loadOffNodeConfig(path);
  const controller = await openControllerStore(join(root, "source"), undefined, {
    acknowledgeJournal: offNode.journal.acknowledge,
  });
  const capture = createControllerBackup({
    store: controller.store,
    keys: controller.keys,
    maintenance: createMaintenance(),
  });
  return { remote, root, offNode, controller, capture };
}

for (const { dimension, staging } of policies) {
  test.skipIf(!enabled)(
    `off-node capture rejects a real archive before its finite ${dimension} budget is exceeded`,
    async () => {
      const f = await fixture();
      try {
        const disk = await statfs(f.root);
        expect(disk.bavail * disk.bsize).toBeGreaterThan(64 * 1024 ** 2);
        const deps = { store: f.controller.store, offNode: f.offNode, backup: f.capture, staging };
        const id = randomUUID();
        await expect(createOffNodeBackup(deps)(id, new AbortController().signal)).rejects.toThrow("capacity");
        expect(await f.remote.storage.versions(`accounts/${f.offNode.config.accountId}/backups/${id}/`)).toHaveLength(
          0,
        );
        const names = await readdir(join(f.root, "operations", id));
        expect(names.some((name) => name.endsWith(".tar") || name.endsWith(".enc") || name.endsWith(".partial"))).toBe(
          false,
        );
      } finally {
        await f.controller.store.close();
        await f.remote.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.skipIf(!enabled)(
    `fresh restore rejects real remote bytes before its finite ${dimension} budget is exceeded`,
    async () => {
      const f = await fixture();
      try {
        const receipt = await createOffNodeBackup({ store: f.controller.store, offNode: f.offNode, backup: f.capture })(
          randomUUID(),
          new AbortController().signal,
        );
        await f.controller.store.close();
        const input = {
          operationId: randomUUID(),
          receipt,
          offNode: f.offNode,
          staging,
          dataDir: join(f.root, "fresh"),
          checkpointDir: join(f.root, "checkpoints"),
          journalDir: join(f.root, "journal"),
        };
        if (dimension === "bytes") expect(receipt.object.bytes).toBeGreaterThan(staging.maxBytes);
        else {
          expect(staging.maxBytes).toBeGreaterThan(receipt.object.bytes * 4 + 128 * 1024 ** 2);
          expect(receipt.staging.contents.files).toBeGreaterThan(staging.maxFiles);
        }
        await expect(restoreOffNodeBackup(input)).rejects.toThrow("capacity");
        expect(await Bun.file(join(input.dataDir, "LOCK")).exists()).toBe(false);
        const names = await readdir(join(f.root, "restores", input.operationId));
        expect(names.some((name) => name === "backup.enc" || name === "backup.tar")).toBe(false);
      } finally {
        await f.controller.store.close();
        await f.remote.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
