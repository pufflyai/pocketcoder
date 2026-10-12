import { dirname, resolve } from "node:path";
import { readPrivateFile, requireOutsideDataFolder, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import type { ManagerBackupConfig } from "../backup/config";
import type { ManagerPurgeConfig } from "../purge/config";
import {
  captureManagerBackup,
  completeManagerRecovery,
  ManagerReceiptSchema,
  restoreManagerBackup,
} from "./manager-backup";

export async function managerRecoveryCommand(
  args: string[],
  dataDir: string,
  purge?: ManagerPurgeConfig,
  backups?: ManagerBackupConfig,
) {
  const [command, receiptPath, operationId] = args;
  if (!["backup", "restore", "recover"].includes(command ?? "")) return false;
  if (!purge || !backups || !receiptPath || !operationId || args.length !== 3)
    throw new Error(
      "Provide backup|restore|recover RECEIPT_PATH OPERATION_UUID with private purge and backup configuration.",
    );
  const path = resolve(receiptPath);
  await requireOutsideDataFolder(dataDir, command === "backup" ? dirname(path) : path);
  const options = {
    dataDir,
    purge,
    encryptionKeyFile: backups.encryptionKeyFile,
    staging: backups.staging,
    operationId,
  };
  if (command === "backup") {
    const receipt = await captureManagerBackup(options);
    await writePrivateJson(path, receipt, 16 * 1024 ** 2);
    console.log(
      JSON.stringify({
        operation_id: operationId,
        receipt: path,
        object: receipt.object.key,
        version_id: receipt.object.versionId,
      }),
    );
  } else {
    const receipt = ManagerReceiptSchema.parse(JSON.parse((await readPrivateFile(path, 16 * 1024 ** 2)).toString()));
    if (command === "restore") await restoreManagerBackup({ ...options, receipt });
    else await completeManagerRecovery({ ...options, receipt });
    console.log(
      JSON.stringify({ operation_id: operationId, state: command === "restore" ? "recovery_required" : "completed" }),
    );
  }
  return true;
}
