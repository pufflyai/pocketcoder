import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type {
  KeyListFilter,
  MachineKeyInsert,
  MachineKeyRow,
  PrincipalRow,
} from "@pstdio/pocketcoder-runtime-contracts";

import type { MemoryState } from "../../state/memory-store-base";

export class MemoryAuthStore {
  constructor(private readonly context: Pick<MemoryState, "principals" | "keys">) {}
  async createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow> {
    if (this.context.principals.some((p) => p.name === name)) {
      throw new Error(`principal exists: ${name}`);
    }
    const row: PrincipalRow = {
      id: randomUUID(),
      name,
      scopes,
      templateNames,
      disabledAt: null,
      createdAt: new Date(),
    };
    this.context.principals.push(row);
    return row;
  }

  async getPrincipalByName(name: string): Promise<PrincipalRow | null> {
    return this.context.principals.find((p) => p.name === name) ?? null;
  }

  async getPrincipal(id: string) {
    return this.context.principals.find((row) => row.id === id) ?? null;
  }

  async listMachineKeys(principalId: string, filter: KeyListFilter) {
    return this.context.keys
      .filter(
        (row) =>
          row.principalId === principalId &&
          (!filter.cursor || row.id > filter.cursor) &&
          (!filter.requestId || row.issuanceRequestId === filter.requestId),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, filter.limit)
      .map((row) => ({ ...row }));
  }

  async revokePrincipalKeys(principalId: string, at: Date) {
    const principal = this.context.principals.find((row) => row.id === principalId);
    if (!principal) return;
    principal.disabledAt = at;
    for (const key of this.context.keys) if (key.principalId === principalId) key.revokedAt ??= at;
  }

  async listPrincipals(): Promise<PrincipalRow[]> {
    return this.context.principals.map((p) => ({ ...p }));
  }

  async updatePrincipal(id: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow | null> {
    const row = this.context.principals.find((principal) => principal.id === id);
    if (!row) return null;
    row.scopes = [...scopes];
    row.templateNames = [...templateNames];
    return { ...row };
  }

  async setPrincipalDisabled(id: string, disabled: boolean): Promise<void> {
    const row = this.context.principals.find((p) => p.id === id);
    if (row) {
      row.disabledAt = disabled ? new Date() : null;
    }
  }

  async insertMachineKey(row: MachineKeyInsert): Promise<void> {
    await this.issueMachineKey({
      ...row,
      issuanceRequestId: row.issuanceRequestId ?? null,
      issuanceRequestDigest: row.issuanceRequestDigest ?? null,
      managedPrincipalIds: row.managedPrincipalIds ?? [],
    });
  }

  async issueMachineKey(row: MachineKeyRow) {
    const principal = this.context.principals.find((principal) => principal.id === row.principalId);
    if (!principal) throw new ApiError("auth.invalid_key", "Unknown principal.");
    const existing = row.issuanceRequestId
      ? this.context.keys.find(
          (key) => key.principalId === row.principalId && key.issuanceRequestId === row.issuanceRequestId,
        )
      : null;
    if (existing)
      return {
        key: { ...existing },
        created: false,
        conflict: existing.issuanceRequestDigest !== row.issuanceRequestDigest,
      };
    if (principal.disabledAt) throw new ApiError("auth.disabled_principal", "This principal is disabled.");
    if (row.issuanceRequestId && row.expiresAt && row.expiresAt <= new Date())
      throw new ApiError("validation.invalid", "Key expiry must be in the future.");
    if (row.scopes.some((scope) => !principal.scopes.includes("admin") && !principal.scopes.includes(scope)))
      throw new ApiError("auth.missing_scope", "Key scopes exceed the principal's authority.");
    this.context.keys.push({ ...row });
    return { key: { ...row }, created: true, conflict: false };
  }

  async getMachineKeyWithPrincipal(keyId: string): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null> {
    const key = this.context.keys.find((k) => k.id === keyId);
    if (!key) return null;
    const principal = this.context.principals.find((p) => p.id === key.principalId);
    if (!principal) return null;
    return { key: { ...key }, principal: { ...principal } };
  }

  async revokeMachineKey(keyId: string, at: Date): Promise<boolean> {
    const key = this.context.keys.find((k) => k.id === keyId);
    if (!key || key.revokedAt) return false;
    key.revokedAt = at;
    return true;
  }

  async touchMachineKey(keyId: string, at: Date): Promise<void> {
    const key = this.context.keys.find((k) => k.id === keyId);
    if (key) key.lastUsedAt = at;
  }
}
