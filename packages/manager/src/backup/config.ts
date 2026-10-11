import { hkdfSync } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isAbsolute } from "node:path";
import {
  createJournalReplica,
  ObjectStorageConfigSchema,
  readPrivateFile,
  requireOutsideDataFolder,
  StagingPolicySchema,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";

const Config = z.strictObject({
  storage: ObjectStorageConfigSchema,
  encryptionKeyFile: z.string().refine(isAbsolute),
  staging: StagingPolicySchema.default({}),
});
export async function loadManagerBackupConfig(path: string, dataDir: string) {
  await requireOutsideDataFolder(dataDir, path);
  const config = Config.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
  await requireOutsideDataFolder(dataDir, config.encryptionKeyFile);
  const master = await readPrivateFile(config.encryptionKeyFile, 32);
  if (master.length !== 32) throw new Error("Manager backups require a separate 32-byte encryption key.");
  function key(accountId: string) {
    return Buffer.from(hkdfSync("sha256", master, accountId, "pocketcoder-off-node-account/v1", 32));
  }
  return {
    storage: config.storage,
    async destinations() {
      const endpoint = new URL(config.storage.endpoint);
      const addresses = await lookup(endpoint.hostname, { all: true });
      if (!addresses.length) throw new Error("Object storage destinations are missing.");
      const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
      return addresses.map(({ address, family }) => ({ cidr: `${address}/${family === 6 ? 128 : 32}`, port }));
    },
    accountFiles(accountId: string) {
      return {
        "config.json": Buffer.from(
          JSON.stringify({
            accountId,
            storage: config.storage,
            encryptionKeyFile: "/private/off-node/outer-key",
            staging: config.staging,
          }),
        ).toString("base64"),
        "outer-key": key(accountId).toString("base64"),
      };
    },
    replica: (accountId: string) => createJournalReplica(config.storage, accountId, key(accountId)),
  };
}
export type ManagerBackupConfig = Awaited<ReturnType<typeof loadManagerBackupConfig>>;
