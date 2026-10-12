import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { readPrivateFile, requireOutsideDataFolder, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
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
    const backups = await loadManagerBackupConfig(input.backupConfig, input.dataDir);
    const purge = await loadManagerPurgeConfig(input.purgeConfig, input.dataDir, backups);
    const day = backupWindow();
    const identityFile = join(state.dir, `${day}.operation.json`);
    const identity = existsSync(identityFile)
      ? z.object({ operationId: z.uuid() }).parse(JSON.parse((await readPrivateFile(identityFile, 4096)).toString()))
      : { operationId: randomUUID() };
    await writePrivateJson(identityFile, identity, 4096);
    const receipt = await captureManagerBackup({
      dataDir: input.dataDir,
      purge,
      operationId: identity.operationId,
      encryptionKeyFile: backups.encryptionKeyFile,
      staging: backups.staging,
    });
    await writePrivateJson(join(state.dir, `${day}.receipt.json`), receipt, 16 * 1024 ** 2);
    return receipt;
  } finally {
    state.close();
  }
}
