import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManagerBackupConfig } from "../backup/config";
import { loadManagerPurgeConfig } from "./config";

test("loaded manager backup and purge configuration require one canonical object store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc94-config-"));
  try {
    const storage = {
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      bucket: "private-account-data",
      accessKeyId: "private-manager",
      secretAccessKey: "private-manager-secret",
    };
    const key = join(root, "outer-key");
    await writeFile(key, Buffer.alloc(32, 1), { mode: 0o600 });
    const backupPath = join(root, "backup.json");
    await writeFile(backupPath, JSON.stringify({ storage, encryptionKeyFile: key }), { mode: 0o600 });
    const backups = await loadManagerBackupConfig(backupPath, join(root, "data"));
    const purgePath = join(root, "purge.json");
    await writeFile(
      purgePath,
      JSON.stringify({ directory: join(root, "authority"), storage: { ...storage, bucket: "another-store" } }),
      { mode: 0o600 },
    );
    await expect(loadManagerPurgeConfig(purgePath, join(root, "data"), backups)).rejects.toThrow("same object storage");
    await writeFile(purgePath, JSON.stringify({ directory: join(root, "authority"), storage }), { mode: 0o600 });
    expect((await loadManagerPurgeConfig(purgePath, join(root, "data"), backups)).storage).toEqual(backups.storage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
