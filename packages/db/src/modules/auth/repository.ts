import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { createKeyInventory } from "./key-inventory";

export function createAuth(context: DatabaseContext) {
  const {
    db,
    tables: { principals, machineKeys },
  } = context;
  return {
    ...createKeyInventory(context),
    async getPrincipal(id: string) {
      const [row] = await db.select().from(principals).where(eq(principals.id, id));
      return row ?? null;
    },
    async createPrincipal(name: string, scopes: string[], templateNames: string[]) {
      const [row] = await db
        .insert(principals)
        .values({ id: randomUUID(), name, scopes, templateNames, createdAt: sql`now()` })
        .returning();
      return requiredRow(row);
    },
    async getPrincipalByName(name: string) {
      const [row] = await db.select().from(principals).where(eq(principals.name, name));
      return row ?? null;
    },
    async listPrincipals() {
      return db.select().from(principals).orderBy(asc(principals.name));
    },
    async updatePrincipal(id: string, scopes: string[], templateNames: string[]) {
      const [row] = await db.update(principals).set({ scopes, templateNames }).where(eq(principals.id, id)).returning();
      return row ?? null;
    },
    async setPrincipalDisabled(id: string, disabled: boolean) {
      await db
        .update(principals)
        .set({ disabledAt: disabled ? sql`now()` : null })
        .where(eq(principals.id, id));
    },
    async getMachineKeyWithPrincipal(keyId: string) {
      const [row] = await db
        .select({ key: machineKeys, principal: principals })
        .from(machineKeys)
        .innerJoin(principals, eq(principals.id, machineKeys.principalId))
        .where(eq(machineKeys.id, keyId));
      return row ?? null;
    },
    async revokeMachineKey(keyId: string, at: Date) {
      const rows = await db
        .update(machineKeys)
        .set({ revokedAt: at })
        .where(and(eq(machineKeys.id, keyId), isNull(machineKeys.revokedAt)))
        .returning({ id: machineKeys.id });
      return rows.length > 0;
    },
    async touchMachineKey(keyId: string, at: Date) {
      await db
        .update(machineKeys)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(machineKeys.id, keyId),
            or(isNull(machineKeys.lastUsedAt), lt(machineKeys.lastUsedAt, new Date(at.getTime() - 60_000))),
          ),
        );
    },
  };
}
