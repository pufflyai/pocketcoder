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
  // Null inherits live principal grants; an empty list permits no templates.
  templateNames: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  issuanceRequestId: string | null;
  issuanceRequestDigest: string | null;
  managedPrincipalIds: string[];
}

export type MachineKeyInsert = Omit<
  MachineKeyRow,
  "issuanceRequestId" | "issuanceRequestDigest" | "managedPrincipalIds" | "templateNames"
> &
  Partial<Pick<MachineKeyRow, "issuanceRequestId" | "issuanceRequestDigest" | "managedPrincipalIds" | "templateNames">>;

export interface KeyListFilter {
  limit: number;
  cursor?: string;
  requestId?: string;
}

export interface PrincipalPatch {
  scopes?: string[];
  templateNames?: string[];
  disabled?: boolean;
}

export interface AuthStore {
  bootstrapOwnerKey(
    input: Omit<MachineKeyRow, "principalId"> & { issuanceRequestId: string },
    replace: boolean,
  ): Promise<{ key: MachineKeyRow; principal: PrincipalRow; created: boolean; conflict: boolean }>;
  createManagedPrincipal(
    actorKeyId: string,
    name: string,
    scopes: string[],
    templateNames: string[],
  ): Promise<PrincipalRow>;
  updateManagedPrincipal(actorKeyId: string, id: string, patch: PrincipalPatch): Promise<PrincipalRow>;
  createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow>;
  getPrincipalByName(name: string): Promise<PrincipalRow | null>;
  getPrincipal(id: string): Promise<PrincipalRow | null>;
  listPrincipals(): Promise<PrincipalRow[]>;
  updatePrincipal(id: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow | null>;
  setPrincipalDisabled(id: string, disabled: boolean): Promise<void>;
  insertMachineKey(row: MachineKeyInsert): Promise<void>;
  issueMachineKey(
    row: MachineKeyRow,
    actorKeyId?: string,
  ): Promise<{ key: MachineKeyRow; principal: PrincipalRow; created: boolean; conflict: boolean }>;
  listMachineKeys(principalId: string, filter: KeyListFilter): Promise<MachineKeyRow[]>;
  revokePrincipalKeys(principalId: string, at: Date, actorKeyId?: string): Promise<void>;
  getMachineKeyWithPrincipal(keyId: string): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null>;
  revokeMachineKey(keyId: string, at: Date, actorKeyId?: string): Promise<boolean>;
  touchMachineKey(keyId: string, at: Date): Promise<void>;
}
