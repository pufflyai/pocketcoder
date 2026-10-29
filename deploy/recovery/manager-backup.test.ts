import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { managerBackupProbe, managerMonitoring } from "@pstdio/pocketcoder-manager/monitoring";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { backupWindow } from "./backup-window";
import { captureDailyManagerBackup } from "./manager-backup";

test("a damaged schedule identity records failure and keeps the previous verified receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc103-manager-identity-"));
  const directory = join(root, "receipts");
  const identityFile = join(directory, `${backupWindow()}.operation.json`);
  const healthFile = join(directory, "health.json");
  const receiptFile = "2026-10-12T00.receipt.json";
  try {
    await writePrivateJson(healthFile, {
      operationId: randomUUID(),
      attemptedAt: "2026-10-12T00:45:00Z",
      result: "succeeded",
      receiptFile,
    });
    await writeFile(identityFile, "invalid JSON", { mode: 0o600 });
    await expect(
      captureDailyManagerBackup({
        dataDir: join(root, "manager"),
        directory,
        purgeConfig: join(root, "purge.json"),
        backupConfig: join(root, "backup.json"),
      }),
    ).rejects.toThrow();
    const failed = await Bun.file(healthFile).json();
    expect(failed).toMatchObject({ result: "failed", receiptFile });
    expect(failed.operationId).toBeUndefined();
    expect(Date.parse(failed.attemptedAt)).toBeGreaterThan(Date.parse("2026-10-12T00:45:00Z"));
    expect(await Bun.file(identityFile).text()).toBe("invalid JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
      const healthFile = join(input.directory, "health.json");
      expect(await Bun.file(healthFile).json()).toMatchObject({ result: "failed" });
      await store.close();
      store = undefined;
      const first = await captureDailyManagerBackup(input);
      const repeated = await captureDailyManagerBackup(input);
      expect(repeated).toEqual(first);
      expect((await storage.storage.versions("manager/backups/")).filter(({ deleted }) => !deleted)).toHaveLength(1);
      expect(first.object.digest).not.toBe(first.plaintext.digest);
      expect(await Bun.file(healthFile).json()).toMatchObject({ result: "succeeded" });
      store = await ManagerStore.create(dataDir, purge);
      const monitoring = managerMonitoring(store, {
        backup: managerBackupProbe(input.directory, first.journal.journalId),
      });
      try {
        await monitoring.sample();
        const metrics = await monitoring.metrics();
        expect(metrics).toContain("pocketcoder_manager_backup_present 1");
        expect(metrics).toContain("pocketcoder_manager_backup_failed 0");
        expect(metrics).not.toContain(first.object.versionId);
        await expect(captureDailyManagerBackup(input)).rejects.toThrow("data folder is in use");
        await monitoring.sample();
        const failed = await monitoring.metrics();
        expect(failed).toContain("pocketcoder_manager_backup_failed 1");
        expect(failed).toContain("pocketcoder_manager_backup_present 1");
      } finally {
        await monitoring.close();
      }
    } finally {
      await store?.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
