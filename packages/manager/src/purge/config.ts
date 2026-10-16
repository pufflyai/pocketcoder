import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ObjectStorageConfigSchema, readPrivateFile, requireOutsideDataFolder } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { SourceConfigSchema } from "../recovery/source-binding";
import { createDigitalOceanStorage } from "./digitalocean";

const Config = z.strictObject({
  directory: z.string().refine(isAbsolute),
  storage: ObjectStorageConfigSchema,
  source: SourceConfigSchema.optional(),
  physical: z
    .strictObject({ provider: z.literal("digitalocean"), credentialFile: z.string().refine(isAbsolute) })
    .optional(),
});

export async function loadManagerPurgeConfig(
  path: string,
  dataDir: string,
  backups?: { storage: z.infer<typeof ObjectStorageConfigSchema> },
) {
  await requireOutsideDataFolder(dataDir, path);
  const config = Config.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
  if (config.source) {
    for (const file of [config.source.credentialFile, config.source.blockDevice, config.source.migrationFile].filter(
      (value): value is string => Boolean(value),
    )) {
      await requireOutsideDataFolder(dataDir, file);
      await requireOutsideDataFolder(config.directory, file);
    }
  }
  if (backups && !isDeepStrictEqual(config.storage, backups.storage))
    throw new Error("Manager backups and purge must use the same object storage.");
  return config;
}
export type ManagerPurgeConfig = Awaited<ReturnType<typeof loadManagerPurgeConfig>>;

export async function loadPurgePhysicalStorage(config: ManagerPurgeConfig, dataDir: string) {
  if (!config.physical) return undefined;
  await requireOutsideDataFolder(dataDir, config.physical.credentialFile);
  const credential = z
    .strictObject({ token: z.string().min(1), expiresAt: z.iso.datetime() })
    .parse(JSON.parse((await readPrivateFile(config.physical.credentialFile, 65_536)).toString()));
  return createDigitalOceanStorage({ token: credential.token, expiresAt: new Date(credential.expiresAt) });
}
