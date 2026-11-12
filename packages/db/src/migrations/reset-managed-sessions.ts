import { isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { SqlClient } from "../database/sql-client";
import { createSchema } from "../schema";

export const MANAGED_SESSION_RESET = "20261112091552_melted_namorita";

// 0.15 deliberately recreates managed data. Compile deletes from the schema, then run them in
// the same transaction as Drizzle's generated migration. Plain workspaces and history remain.
export async function resetManagedSessions(client: SqlClient, schema: string) {
  const tables = createSchema(schema),
    db = drizzle.mock();
  const queries = [
    db.delete(tables.workspaceLeases).where(isNotNull(tables.workspaceLeases.managedAuthority)),
    db.delete(tables.conversationRequests).where(isNotNull(tables.conversationRequests.managed)),
    db.delete(tables.sessionInputs),
    db.delete(tables.managedObservations),
    db.delete(tables.managedCapacity),
    db.delete(tables.managedSessions),
    db.delete(tables.managedProfiles),
  ];
  for (const query of queries) {
    const statement = query.toSQL();
    await client.query(statement.sql, statement.params);
  }
}
