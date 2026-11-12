import { randomUUID } from "node:crypto";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeaseRequest, WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull, lte, notInArray } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { leaseSourceIdentity, leaseWorkspaceActive } from "./lease-authority";
import { managedLeaseActive } from "./managed-lease-authority";

const closed = ["revoked", "expired", "superseded", "revoking"] as const;
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
  const pending = await tx.select({ authority: leases.managedAuthority }).from(leases).where(sameReference);
  // Sessions sharing a workspace each keep a lease and its renewal on the same issuer.
  const own = input.managedAuthority;
  const counted = own
    ? pending.filter(({ authority }) => authority?.sessionId === own.sessionId && authority.slot === own.slot)
    : pending;
  if (counted.length >= 2) throw new Error("Workspace lease limit reached");
}

function assertRequestIdentity(row: WorkspaceLeaseRow, input: WorkspaceLeaseRequest, templateDigest: string) {
  if (
    row.secretVersionId !== input.secretVersionId ||
    row.workspaceId !== input.workspaceId ||
    row.policyDigest !== input.policyDigest ||
    row.templateDigest !== templateDigest ||
    digestOf(row.managedAuthority) !== digestOf(input.managedAuthority ?? null) ||
    row.purpose !== input.purpose
  )
    throw new Error("Lease request identity changed");
}

export async function requestLease({ db, tables }: DatabaseContext, input: WorkspaceLeaseRequest) {
  const { workspaces, workspaceLeases: leases, workspaceLeaseFences: fences } = tables;
  async function workspace(tx: Transaction, id: string) {
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
    return requiredRow(row);
  }
  async function fenced(tx: Transaction, id: string) {
    const [row] = await tx.select().from(fences).where(eq(fences.workspaceId, id));
    return Boolean(row);
  }

  return db.transaction(async (tx) => {
    // Name first: publication/retirement and lease admission use one order.
    await lock(tx, input.secretName, 4);
    const owner = await workspace(tx, input.workspaceId);
    if (await fenced(tx, owner.id)) throw new Error("Lease workspace is fenced");
    if (!leaseWorkspaceActive(owner, input.purpose, input.at)) throw new Error("Lease workspace is inactive");
    if (!input.managedAuthority) await requireVaultIssuer(tx, tables, input);
    const [existing] = await tx
      .select()
      .from(leases)
      .where(and(eq(leases.secretName, input.secretName), eq(leases.requestId, input.requestId)));
    if (existing) {
      assertRequestIdentity(existing, input, owner.templateDigest);
      return existing;
    }
    if (
      !(await managedLeaseActive(
        tx,
        tables,
        owner,
        input.managedAuthority ?? null,
        input.secretName,
        input.secretVersionId,
        input.at,
      ))
    )
      throw new Error("Managed lease authority is unavailable");
    const sourceIdentity = input.managedAuthority
      ? { sourceUrl: null, sourceRevision: null }
      : leaseSourceIdentity(owner, input.purpose, input.secretName);
    await enforceReferenceLimit(tx, leases, input);
    const requestExpiresAt = new Date(Math.min(owner.deadlineAt.getTime(), input.at.getTime() + 300_000));
    const identity = {
      managedAuthority: input.managedAuthority ?? null,
      workspaceId: owner.id,
      secretName: input.secretName,
      secretVersionId: input.secretVersionId,
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
}

async function requireVaultIssuer(tx: Transaction, tables: DatabaseContext["tables"], input: WorkspaceLeaseRequest) {
  const { secrets } = tables;
  const [issuer] = await tx
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.name, input.secretName),
        ...(input.managedAuthority ? [] : [eq(secrets.versionId, input.secretVersionId!)]),
        eq(secrets.type, input.purpose),
        isNull(secrets.retiredAt),
      ),
    );
  if (!issuer) throw new Error("Lease issuer is unavailable");
  const [pinned] = await tx
    .select()
    .from(tables.secretVersions)
    .where(
      and(
        eq(tables.secretVersions.id, input.secretVersionId!),
        eq(tables.secretVersions.name, input.secretName),
        eq(tables.secretVersions.type, input.purpose),
      ),
    );
  if (!pinned) throw new Error("Lease issuer is unavailable");
}
