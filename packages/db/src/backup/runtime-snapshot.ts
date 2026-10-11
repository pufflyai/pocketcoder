import type { PGlite } from "@electric-sql/pglite";
import { TERMINAL_STATES } from "@pstdio/pocketcoder-contracts";
import { and, asc, isNotNull, ne, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { runtimeIdentity } from "../off-node/runtime-identity";
import { createSchema } from "../schema";
import { requireSettledProviderLaunches } from "./snapshot-queries";

// This reads the verified copy, after extraction, rather than the controller's newer live rows.
export async function readRuntimeSnapshot(client: PGlite) {
  await requireSettledProviderLaunches(client, "pocketcoder");
  const db = drizzle({ client });
  const { workspaces, warmPoolRuntimes: warm } = createSchema("pocketcoder");
  const rows = await db
    .select({ id: workspaces.id, provider: workspaces.providerKind, ref: workspaces.providerRef })
    .from(workspaces)
    .where(and(notInArray(workspaces.state, [...TERMINAL_STATES]), isNotNull(workspaces.providerRef)))
    .orderBy(asc(workspaces.id));
  const pools = await db
    .select({ id: warm.id, provider: warm.driverKind, ref: warm.providerRef })
    .from(warm)
    .where(and(ne(warm.state, "failed"), isNotNull(warm.providerRef)))
    .orderBy(asc(warm.id));
  return [
    ...rows.map((row) => runtimeIdentity("workspace", row.id, row.provider, row.ref as Record<string, unknown>)),
    ...pools.map((row) => runtimeIdentity("warm", row.id, row.provider, row.ref as Record<string, unknown>)),
  ];
}
