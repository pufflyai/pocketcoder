export interface PrincipalRow {
  id: string;
  name: string;
  scopes: string[];
  templateNames: string[];
  disabledAt: Date | null;
  createdAt: Date;
}

export interface MachineKeyRow {
  id: string;
  principalId: string;
  secretDigest: Uint8Array;
  // Empty means inherit the principal's live scopes; non-empty narrows them.
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface AuthStore {
  createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow>;
  getPrincipalByName(name: string): Promise<PrincipalRow | null>;
  listPrincipals(): Promise<PrincipalRow[]>;
  updatePrincipal(id: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow | null>;
  setPrincipalDisabled(id: string, disabled: boolean): Promise<void>;
  insertMachineKey(row: MachineKeyRow): Promise<void>;
  getMachineKeyWithPrincipal(keyId: string): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null>;
  revokeMachineKey(keyId: string, at: Date): Promise<boolean>;
  touchMachineKey(keyId: string, at: Date): Promise<void>;
}
