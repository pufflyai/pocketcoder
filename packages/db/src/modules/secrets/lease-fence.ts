import { isTerminal, type WorkspaceState } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, notInArray } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export const pendingWorkspaceLeases = (tables: DatabaseContext["tables"], id: string) =>
  and(eq(tables.workspaceLeases.workspaceId, id), notInArray(tables.workspaceLeases.state, ["revoked", "expired"]));

// The caller owns the workspace row lock throughout this transaction.
export async function fenceWorkspaceLeaseRows(
  tx: Transaction,
  tables: DatabaseContext["tables"],
  workspaceId: string,
  at: Date,
) {
  await tx.insert(tables.workspaceLeaseFences).values({ workspaceId, createdAt: at }).onConflictDoNothing();
  await tx
    .update(tables.workspaceLeases)
    .set({ state: "revoking", updatedAt: at })
    .where(pendingWorkspaceLeases(tables, workspaceId));
}

export async function prepareLeaseTransition(
  tx: Transaction,
  tables: DatabaseContext["tables"],
  workspaceId: string,
  to: WorkspaceState,
  at: Date,
) {
  if (!isTerminal(to) && to !== "terminating" && to !== "preserving") return true;
  await fenceWorkspaceLeaseRows(tx, tables, workspaceId, at);
  if (!isTerminal(to)) return true;
  const [pending] = await tx
    .select({ id: tables.workspaceLeases.id })
    .from(tables.workspaceLeases)
    .where(pendingWorkspaceLeases(tables, workspaceId))
    .limit(1);
  return !pending;
}

export async function setupLeaseClosed(tx: Transaction, tables: DatabaseContext["tables"], row: WorkspaceRow) {
  const source = row.launchMode === "create" && row.sourceDescriptor;
  const reference = source && row.templateSnapshot.spec.source?.repositories[source.repository]?.credential;
  if (!reference) return true;
  const leases = await tx.select().from(tables.workspaceLeases).where(eq(tables.workspaceLeases.workspaceId, row.id));
  return (
    leases.some((lease) => lease.secretName === reference.slice(10) && lease.deliveredAt !== null) &&
    leases
      .filter((lease) => lease.purpose === "setup-issuer")
      .every((lease) => lease.state === "revoked" || lease.state === "expired")
  );
}
