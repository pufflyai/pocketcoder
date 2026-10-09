import { randomUUID } from "node:crypto";
import {
  ApiError,
  SecretNameSchema,
  type SecretPutRequest,
  SecretPutRequestSchema,
  type SecretType,
} from "@pstdio/pocketcoder-contracts";
import type { EncryptedSecret, SecretMetadata, SecretStore } from "@pstdio/pocketcoder-runtime-core";
import { openSecret, sealSecret } from "./secret-cipher";

const resource = ({ name, type, updatedAt, retiredAt }: SecretMetadata) => ({
  name,
  type,
  updated_at: updatedAt.toISOString(),
  retired_at: retiredAt?.toISOString() ?? null,
});

export function createSecretVault(store: SecretStore, encryptionKey: Uint8Array) {
  function decrypt(row: EncryptedSecret | null, purpose: SecretType) {
    // Crypto and JSON failures must never put a value in a response or log.
    try {
      if (!row) throw new Error("Missing secret.");
      const value: unknown = JSON.parse(openSecret(encryptionKey, row, row, purpose));
      const parsed = SecretPutRequestSchema.parse({ type: row.type, value });
      return { id: row.id, name: row.name, ...parsed };
    } catch {
      throw new ApiError("secret.unavailable", "Stored secret is unavailable.");
    }
  }
  return {
    async put(actorKeyId: string, name: string, input: SecretPutRequest) {
      const parsed = SecretPutRequestSchema.safeParse(input);
      if (!SecretNameSchema.safeParse(name).success || !parsed.success)
        throw new ApiError("validation.invalid", "Invalid stored secret request.");
      const identity = { id: randomUUID(), name, type: parsed.data.type };
      const sealed = sealSecret(encryptionKey, identity, JSON.stringify(parsed.data.value));
      return resource(await store.writeSecret(actorKeyId, { ...identity, ...sealed }));
    },
    async list(actorKeyId: string) {
      return (await store.listSecrets(actorKeyId)).map(resource);
    },
    async retire(actorKeyId: string, name: string) {
      return resource(await store.retireSecret(actorKeyId, name));
    },
    async resolve(name: string, purpose: SecretType) {
      return decrypt(await store.readSecret(name), purpose);
    },
    async resolveVersion(id: string, purpose: SecretType) {
      return decrypt(await store.readSecretVersion(id), purpose);
    },
  };
}
