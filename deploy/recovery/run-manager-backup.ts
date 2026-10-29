import { captureDailyManagerBackup } from "./manager-backup";

const dataDir = process.env.POCKETCODER_MANAGER_DIR;
const purgeConfig = process.env.POCKETCODER_MANAGER_PURGE_CONFIG;
const backupConfig = process.env.POCKETCODER_MANAGER_OFF_NODE_CONFIG;
const directory = process.env.POCKETCODER_MANAGER_BACKUP_RECEIPTS;
if (!dataDir || !purgeConfig || !backupConfig || !directory)
  throw new Error("Provide private manager, purge, off-node configuration and backup receipt paths.");
const receipt = await captureDailyManagerBackup({ dataDir, purgeConfig, backupConfig, directory });
console.log(JSON.stringify({ operationId: receipt.operationId, recoveryPoint: receipt.createdAt }));
