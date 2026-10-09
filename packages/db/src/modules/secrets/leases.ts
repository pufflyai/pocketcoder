import { randomUUID } from "node:crypto";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeaseRequest, WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, isNull, lte, notInArray } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { leaseSourceIdentity, leaseWorkspaceActive } from "./lease-authority";
import { fenceWorkspaceLeaseRows } from "./lease-fence";

const closed = ["revoked", "expired"] as const;
const isClosed = (state: string) => state === "revoked" || state === "expired";

async function enforceReferenceLimit(
  tx: Transaction,
  leases: DatabaseContext["tables"]["workspaceLeases"],
  input: WorkspaceLeaseRequest,
) {
  const sameReference = and(
    eq(leases.workspaceId, input.workspaceId),
    eq(leases.secretName, input.secretName),
    eq(leases.purpose, input.purpose),
    notInArray(leases.state, [...closed]),
  );
  await tx
    .update(leases)
    .set({ state: "expired", closedAt: input.at, updatedAt: input.at })
    .where(and(sameReference, lte(leases.issuerExpiresAt, input.at)));
  const pending = await tx.select({ id: leases.id }).from(leases).where(sameReference);
  if (pending.length >= 2) throw new Error("Workspace lease limit reached");
}

function assertRequestIdentity(row: WorkspaceLeaseRow, input: WorkspaceLeaseRequest, templateDigest: string) {
  if (
    row.secretVersionId !== input.secretVersionId ||
    row.workspaceId !== input.workspaceId ||
    row.policyDigest !== input.policyDigest ||
    row.templateDigest !== templateDigest ||
    row.purpose !== input.purpose
  )
    throw new Error("Lease request identity changed");
}

export function createWorkspaceLeases({ db, tables }: DatabaseContext) {
  const { workspaces, workspaceLeases: leases, workspaceLeaseFences: fences, secrets } = tables;
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
    async requestWorkspaceLease(input: WorkspaceLeaseRequest) {
      return db.transaction(async (tx) => {
        // Name first: publication/retirement and lease admission use one order.
        await lock(tx, input.secretName, 4);
        const owner = await workspace(tx, input.workspaceId);
        if (await fenced(tx, owner.id)) throw new Error("Lease workspace is fenced");
        if (!leaseWorkspaceActive(owner, input.purpose, input.at)) throw new Error("Lease workspace is inactive");
        const [issuer] = await tx
          .select()
          .from(secrets)
          .where(
            and(
              eq(secrets.name, input.secretName),
              eq(secrets.versionId, input.secretVersionId),
              eq(secrets.type, input.purpose),
              isNull(secrets.retiredAt),
            ),
          );
        if (!issuer) throw new Error("Lease issuer is unavailable");
        const [existing] = await tx
          .select()
          .from(leases)
          .where(and(eq(leases.secretName, input.secretName), eq(leases.requestId, input.requestId)));
        if (existing) {
          assertRequestIdentity(existing, input, owner.templateDigest);
          return existing;
        }
        const sourceIdentity = leaseSourceIdentity(owner, input.purpose, input.secretName);
        await enforceReferenceLimit(tx, leases, input);
        const requestExpiresAt = new Date(Math.min(owner.deadlineAt.getTime(), input.at.getTime() + 300_000));
        const identity = {
          workspaceId: owner.id,
          secretName: input.secretName,
          secretVersionId: issuer.versionId,
          purpose: input.purpose,
          ...sourceIdentity,
          templateDigest: owner.templateDigest,
          policyDigest: input.policyDigest,
          requestId: input.requestId,
          requestExpiresAt,
        };
        return requiredRow(
          (
            await tx
              .insert(leases)
              .values({
                id: randomUUID(),
                ...identity,
                requestDigest: digestOf({ ...identity, requestExpiresAt: requestExpiresAt.toISOString() }),
                state: "requested",
                createdAt: input.at,
                updatedAt: input.at,
              })
              .returning()
          )[0],
        );
      });
    },
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
          row.state === "revoking" || (await fenced(tx, owner.id)) || !leaseWorkspaceActive(owner, row.purpose, at);
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
          !leaseWorkspaceActive(owner, row.purpose, at)
        )
          return null;
        return update(tx, id, { state: "delivered", deliveredAt: row.deliveredAt ?? at, updatedAt: at });
      });
    },
    async requestWorkspaceLeaseRevocation(id: string, at: Date) {
      return db.transaction(async (tx) => {
        const { row } = await writable(tx, id);
        if (isClosed(row.state)) return row;
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
