import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { readPrivateFile, requireOutsideDataFolder, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import { readManagerBackupSchedule } from "@pstdio/pocketcoder-manager/monitoring";
import { loadManagerPurgeConfig } from "@pstdio/pocketcoder-manager/purge";
import { captureManagerBackup } from "@pstdio/pocketcoder-manager/recovery";
import { z } from "zod";
import { backupWindow } from "./backup-window";

export async function captureDailyManagerBackup(input: {
  dataDir: string;
  purgeConfig: string;
  backupConfig: string;
  directory: string;
}) {
  await requireOutsideDataFolder(input.dataDir, dirname(input.directory));
  const state = lockDataFolder(input.directory);
  try {
    await requireOutsideDataFolder(input.dataDir, state.dir);
    const prior = await readManagerBackupSchedule(state.dir);
    const health: { operationId?: string; attemptedAt: string; receiptFile?: string } = {
      attemptedAt: new Date().toISOString(),
      ...(prior?.receiptFile ? { receiptFile: prior.receiptFile } : {}),
    };
    const healthFile = join(state.dir, "health.json");
    await writePrivateJson(healthFile, { ...health, result: "started" }, 4096);
    try {
      const day = backupWindow();
      const identityFile = join(state.dir, `${day}.operation.json`);
      const identity = existsSync(identityFile)
        ? z.object({ operationId: z.uuid() }).parse(JSON.parse((await readPrivateFile(identityFile, 4096)).toString()))
        : { operationId: randomUUID() };
      await writePrivateJson(identityFile, identity, 4096);
      health.operationId = identity.operationId;
      await writePrivateJson(healthFile, { ...health, result: "started" }, 4096);
      const backups = await loadManagerBackupConfig(input.backupConfig, input.dataDir);
      const purge = await loadManagerPurgeConfig(input.purgeConfig, input.dataDir, backups);
      const receipt = await captureManagerBackup({
        dataDir: input.dataDir,
        purge,
        operationId: identity.operationId,
        encryptionKeyFile: backups.encryptionKeyFile,
        staging: backups.staging,
      });
      const receiptFile = `${day}.receipt.json`;
      await writePrivateJson(join(state.dir, receiptFile), receipt, 16 * 1024 ** 2);
      await writePrivateJson(healthFile, { ...health, result: "succeeded", receiptFile }, 4096);
      return receipt;
    } catch (error) {
      await writePrivateJson(healthFile, { ...health, result: "failed" }, 4096);
      throw error;
    }
  } finally {
    state.close();
  }
}
