import type { SecretType } from "@pstdio/pocketcoder-contracts";

export interface SecretMetadata {
  name: string;
  type: SecretType;
  updatedAt: Date;
  retiredAt: Date | null;
}
export interface EncryptedSecret {
  id: string;
  name: string;
  type: SecretType;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}
export interface SecretStore {
  writeSecret(actorKeyId: string, secret: EncryptedSecret): Promise<SecretMetadata>;
  listSecrets(actorKeyId: string): Promise<SecretMetadata[]>;
  retireSecret(actorKeyId: string, name: string): Promise<SecretMetadata>;
  readSecret(name: string): Promise<EncryptedSecret | null>;
  readSecretVersion(id: string): Promise<EncryptedSecret | null>;
}
