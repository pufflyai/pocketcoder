import {
  AccountPurgeCompletionSchema,
  type AccountPurgeIntent,
  AccountPurgeIntentSchema,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { requireOutsideDataFolder } from "./config";
import { ObjectStorage, ObjectStorageConfigSchema, ObjectStorageError } from "./object-storage";
import { readPrivateFile } from "./private-files";

export const AccountPurgeConfigSchema = z.strictObject({
  accountId: z.uuid(),
  createRequestDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  storage: ObjectStorageConfigSchema,
});

async function readAccountPurgeMetadata(response: Response) {
  if (!response.body) throw new Error("Purge tombstone body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) throw new Error("Purge tombstone exceeds its metadata limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readAccountPurgeIntent(response: Response) {
  return AccountPurgeIntentSchema.parse(await readAccountPurgeMetadata(response));
}

export function createAccountPurgeReader(config: z.input<typeof AccountPurgeConfigSchema>) {
  const { accountId, createRequestDigest, storage: settings } = AccountPurgeConfigSchema.parse(config);
  const storage = new ObjectStorage(settings);
  let admitted: AccountPurgeIntent | undefined;
  const read = async () => {
    if (admitted) return admitted;
    async function indexed(key: string) {
      try {
        return await readAccountPurgeIntent(await storage.get(key));
      } catch (error) {
        if (error instanceof ObjectStorageError && error.status === 404) return undefined;
        throw error;
      }
    }
    const direct = await indexed(`manager/purge/accounts/${accountId}/intent.json`);
    if (direct && direct.accountId !== accountId) throw new Error("Purge tombstone account differs.");
    const request = createRequestDigest
      ? await indexed(`manager/purge/requests/${createRequestDigest}/intent.json`)
      : undefined;
    if (request && request.createRequestDigest !== createRequestDigest)
      throw new Error("Purge tombstone CREATE binding differs.");
    if (direct && createRequestDigest && direct.createRequestDigest !== createRequestDigest)
      throw new Error("Purge tombstone CREATE binding differs.");
    if (direct && request && JSON.stringify(direct) !== JSON.stringify(request))
      throw new Error("Purge tombstone indexes differ.");
    // The private CREATE binding fences a rollback alias without changing its local account identity.
    admitted = direct ?? request;
    return admitted;
  };
  return Object.assign(read, {
    accountId,
    async completed() {
      const intent = await read();
      if (!intent) return undefined;
      try {
        const receipt = AccountPurgeCompletionSchema.parse(
          await readAccountPurgeMetadata(await storage.get(`manager/purge/accounts/${intent.accountId}/complete.json`)),
        );
        if (JSON.stringify(receipt.intent) !== JSON.stringify(intent))
          throw new Error("Purge completion intent differs.");
        return receipt;
      } catch (error) {
        if (error instanceof ObjectStorageError && error.status === 404) return undefined;
        throw error;
      }
    },
  });
}

export async function loadAccountPurgeReader(path: string, dataDir: string) {
  await requireOutsideDataFolder(dataDir, path);
  const config = AccountPurgeConfigSchema.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
  return createAccountPurgeReader(config);
}
export type AccountPurgeReader = ReturnType<typeof createAccountPurgeReader>;
