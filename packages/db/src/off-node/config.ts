import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { createJournalReplica } from "./journal-replica";
import { ObjectStorage, ObjectStorageConfigSchema } from "./object-storage";
import { readPrivateFile } from "./private-files";
import { StagingPolicySchema } from "./staging-capacity";

export const OffNodeConfigSchema = z.strictObject({
  accountId: z.uuid(),
  storage: ObjectStorageConfigSchema,
  encryptionKeyFile: z.string().refine(isAbsolute),
  staging: StagingPolicySchema.default({}),
});

function outside(dataDir: string, path: string) {
  const rest = relative(resolve(dataDir), resolve(path));
  if (rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`)))
    throw new Error("Off-node credentials and encryption keys must stay outside the data folder.");
}

async function dataPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(path);
    return resolve(await dataPath(dirname(absolute)), basename(absolute));
  }
}

export async function requireOutsideDataFolder(dataDir: string, path: string) {
  outside(await dataPath(dataDir), await realpath(path));
}

export async function loadOffNodeConfig(path: string, dataDir?: string) {
  const config = OffNodeConfigSchema.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
  if (dataDir) {
    await requireOutsideDataFolder(dataDir, path);
    await requireOutsideDataFolder(dataDir, config.encryptionKeyFile);
  }
  const encryptionKey = await readPrivateFile(config.encryptionKeyFile, 32);
  if (encryptionKey.length !== 32) throw new Error("Off-node encryption requires a separate 32-byte key.");
  return {
    config,
    encryptionKey,
    directory: dirname(resolve(path)),
    storage: new ObjectStorage(config.storage),
    journal: createJournalReplica(config.storage, config.accountId, encryptionKey),
  };
}
export type OffNode = Awaited<ReturnType<typeof loadOffNodeConfig>>;

import { realpath } from "node:fs/promises";
