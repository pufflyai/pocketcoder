import type { WorkspaceLeaseRequest } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { leaseWorkspaceActive } from "./lease-authority";
import { fenceWorkspaceLeaseRows } from "./lease-fence";
import { requestLease } from "./lease-requests";
import { managedLeaseActive } from "./managed-lease-authority";

const closed = ["revoked", "expired"] as const;
const isClosed = (state: string) => state === "revoked" || state === "expired";

export function createWorkspaceLeases(context: DatabaseContext) {
  const { db, tables } = context;
  const { workspaces, workspaceLeases: leases, workspaceLeaseFences: fences } = tables;
  async function workspace(tx: Transaction, id: string) {
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
    if (!row) throw new Error("Lease workspace is unavailable");
    return row;
  }
  async function fenced(tx: Transaction, id: string) {
    const [row] = await tx.select().from(fences).where(eq(fences.workspaceId, id));
    return Boolean(row);
  }
  async function writable(tx: Transaction, id: string) {
    const [known] = await tx.select().from(leases).where(eq(leases.id, id));
    if (!known) throw new Error("Lease request is unavailable");
    const owner = await workspace(tx, known.workspaceId);
    const [row] = await tx.select().from(leases).where(eq(leases.id, id)).for("update");
    return { row: requiredRow(row), owner };
  }
  const update = async (tx: Transaction, id: string, patch: Partial<typeof leases.$inferInsert>) =>
    requiredRow((await tx.update(leases).set(patch).where(eq(leases.id, id)).returning())[0]);
  return {
    requestWorkspaceLease: (input: WorkspaceLeaseRequest) => requestLease(context, input),
    async getWorkspaceLease(id: string) {
      return (await db.select().from(leases).where(eq(leases.id, id)))[0] ?? null;
    },
    async hasWorkspaceLeaseFence(workspaceId: string) {
      const [row] = await db.select({ id: fences.workspaceId }).from(fences).where(eq(fences.workspaceId, workspaceId));
      return Boolean(row);
    },
    async listWorkspaceLeases(workspaceId: string) {
      return db
        .select()
        .from(leases)
        .where(eq(leases.workspaceId, workspaceId))
        .orderBy(asc(leases.createdAt), asc(leases.id));
    },
    async listPendingWorkspaceLeases(workspaceId?: string) {
      return db
        .select()
        .from(leases)
        .where(
          and(notInArray(leases.state, [...closed]), workspaceId ? eq(leases.workspaceId, workspaceId) : undefined),
        )
        .orderBy(asc(leases.createdAt), asc(leases.id));
    },
    async recordWorkspaceLeaseIssued(
      id: string,
      issuerLeaseId: string,
      expiresAt: Date,
      credentialBytes: number,
      at: Date,
    ) {
      return db.transaction(async (tx) => {
        const { row, owner } = await writable(tx, id);
        if (isClosed(row.state)) return null;
        if (
          !issuerLeaseId ||
          issuerLeaseId.length > 1024 ||
          !Number.isInteger(credentialBytes) ||
          credentialBytes < 1 ||
          credentialBytes > 65_536 ||
          expiresAt <= row.createdAt ||
          expiresAt > row.requestExpiresAt
        )
          throw new Error("Lease issuer expiry or identity is invalid");
        if (
          row.issuerLeaseId &&
          (row.issuerLeaseId !== issuerLeaseId ||
            row.issuerExpiresAt?.getTime() !== expiresAt.getTime() ||
            row.credentialBytes !== credentialBytes)
        )
          throw new Error("Lease request identity changed");
        const stopped =
          row.state === "revoking" ||
          (await fenced(tx, owner.id)) ||
          !leaseWorkspaceActive(owner, row.purpose, at) ||
          !(await managedLeaseActive(tx, tables, owner, row.managedAuthority, row.secretName, row.secretVersionId, at));
        let state = row.state;
        if (stopped) state = "revoking";
        else if (state !== "delivered") state = "issued";
        return update(tx, id, { issuerLeaseId, issuerExpiresAt: expiresAt, credentialBytes, state, updatedAt: at });
      });
    },
    async recordWorkspaceLeaseDelivered(id: string, at: Date) {
      return db.transaction(async (tx) => {
        const { row, owner } = await writable(tx, id);
        if (
          !["issued", "delivered"].includes(row.state) ||
          !row.issuerExpiresAt ||
          row.issuerExpiresAt <= at ||
          (await fenced(tx, owner.id)) ||
          !leaseWorkspaceActive(owner, row.purpose, at) ||
          !(await managedLeaseActive(tx, tables, owner, row.managedAuthority, row.secretName, row.secretVersionId, at))
        )
          return null;
        return update(tx, id, { state: "delivered", deliveredAt: row.deliveredAt ?? at, updatedAt: at });
      });
    },
    async requestWorkspaceLeaseRevocation(id: string, at: Date) {
      return db.transaction(async (tx) => {
        const { row } = await writable(tx, id);
        if (isClosed(row.state) || row.state === "revoking") return row;
        return update(tx, id, { state: "revoking", updatedAt: at });
      });
    },
    async fenceWorkspaceLeases(workspaceId: string, at: Date) {
      await db.transaction(async (tx) => {
        await workspace(tx, workspaceId);
        await fenceWorkspaceLeaseRows(tx, tables, workspaceId, at);
      });
    },
    async recordWorkspaceLeaseRevoked(id: string, requestId: string, at: Date) {
      return db.transaction(async (tx) => {
        const { row } = await writable(tx, id);
        if (row.requestId !== requestId) throw new Error("Lease request identity changed");
        if (isClosed(row.state)) return row;
        if (row.state !== "revoking") return null;
        return update(tx, id, { state: "revoked", closedAt: at, updatedAt: at });
      });
    },
    async recordWorkspaceLeaseExpired(id: string, at: Date) {
      return db.transaction(async (tx) => {
        const { row } = await writable(tx, id);
        if (isClosed(row.state)) return row;
        if (!row.issuerExpiresAt || row.issuerExpiresAt > at) return null;
        return update(tx, id, { state: "expired", closedAt: at, updatedAt: at });
      });
    },
  };
}
