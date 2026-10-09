import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretType } from "@pstdio/pocketcoder-contracts";

export interface SecretIdentity {
  id: string;
  name: string;
  type: SecretType;
}

interface SealedSecret {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

function authenticatedMetadata({ id, name, type }: SecretIdentity) {
  // Bind immutable versions too, so ciphertext cannot be moved between writes.
  return Buffer.from(JSON.stringify(["pocketcoder-secret/v1", id, name, type]));
}

export function sealSecret(key: Uint8Array, identity: SecretIdentity, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(authenticatedMetadata(identity));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

export function openSecret(key: Uint8Array, identity: SecretIdentity, sealed: SealedSecret, purpose: SecretType) {
  if (identity.type !== purpose) throw new Error("Stored secret has the wrong purpose.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, { authTagLength: 16 });
    decipher.setAAD(authenticatedMetadata(identity));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored secret authentication failed.");
  }
}
