import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { captureDailyManagerBackup } from "./manager-backup";

test.skipIf(process.env.PC103_S3_TEST !== "1")(
  "a scheduled manager capture refuses a live writer and retries one encrypted object",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc103-manager-schedule-"));
    const storage = await objectStorageFixture();
    const dataDir = join(root, "manager");
    const purgeConfig = join(root, "purge.json");
    const backupConfig = join(root, "backup.json");
    const key = join(root, "key");
    const purge = { directory: join(root, "authority"), storage: storage.config };
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    await writeFile(purgeConfig, JSON.stringify(purge), { mode: 0o600 });
    await writeFile(backupConfig, JSON.stringify({ storage: storage.config, encryptionKeyFile: key }), { mode: 0o600 });
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    try {
      store = await ManagerStore.create(dataDir, purge);
      const input = { dataDir, purgeConfig, backupConfig, directory: join(root, "receipts") };
      await expect(captureDailyManagerBackup(input)).rejects.toThrow("data folder is in use");
      expect(await storage.storage.versions("manager/backups/")).toEqual([]);
      await store.close();
      store = undefined;
      const first = await captureDailyManagerBackup(input);
      const repeated = await captureDailyManagerBackup(input);
      expect(repeated).toEqual(first);
      expect((await storage.storage.versions("manager/backups/")).filter(({ deleted }) => !deleted)).toHaveLength(1);
      expect(first.object.digest).not.toBe(first.plaintext.digest);
    } finally {
      await store?.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
