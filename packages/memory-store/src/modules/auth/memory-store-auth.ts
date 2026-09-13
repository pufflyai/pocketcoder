import { randomUUID } from "node:crypto";
import type { MachineKeyRow, PrincipalRow } from "@pstdio/pocketcoder-runtime-contracts";

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

  async insertMachineKey(row: MachineKeyRow): Promise<void> {
    this.context.keys.push({ ...row });
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
