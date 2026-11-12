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

// A plain HTTP issuer is a cluster-local Service; the controller must opt in to calling one.
const plainIssuer = (secret: SecretPutRequest) =>
  secret.type !== "registry" && new URL(secret.value.url).protocol === "http:";

export function createSecretVault(
  store: SecretStore,
  encryptionKey: Uint8Array,
  options: { clusterLocalIssuers?: boolean } = {},
) {
  const refused = (secret: SecretPutRequest) => plainIssuer(secret) && !options.clusterLocalIssuers;
  function decrypt(row: EncryptedSecret | null, purpose: SecretType) {
    // Crypto and JSON failures must never put a value in a response or log.
    try {
      if (!row) throw new Error("Missing secret.");
      const value: unknown = JSON.parse(openSecret(encryptionKey, row, row, purpose));
      const parsed = SecretPutRequestSchema.parse({ type: row.type, value });
      if (refused(parsed)) throw new Error("Plain HTTP issuer is not allowed.");
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
      if (refused(parsed.data))
        throw new ApiError(
          "validation.invalid",
          "A plain HTTP issuer needs a cluster-local host and POCKETCODER_CLUSTER_LOCAL_ISSUERS=true.",
        );
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

// The controller's vault, or none without a secret key. Every caller applies the same issuer policy.
export function controllerVault(store: SecretStore, settings: { secretKey?: string; clusterLocalIssuers?: boolean }) {
  if (!settings.secretKey) return undefined;
  return createSecretVault(store, Buffer.from(settings.secretKey, "base64url"), {
    clusterLocalIssuers: settings.clusterLocalIssuers ?? false,
  });
}
