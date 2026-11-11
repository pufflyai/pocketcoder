import { ApiError, managed, PARALLEL_CONVERSATION_CAPABILITIES } from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { policyOwner } from "../budgets/policy-owner";
import { authorityContext, conflict, unavailable } from "../managed/authority-context";
import { pendingWorkspaceLeases } from "../secrets/lease-fence";

export function placementChecks(context: DatabaseContext) {
  const { tables } = context;
  const { workspaces, managedSessions: sessions } = tables;
  const auth = authorityContext(context);
  async function previousFenced(tx: Transaction, previous: ManagedBinding | null, next: ManagedBinding | null) {
    if (!previous) return;
    if (next?.workspaceId === previous.workspaceId) throw conflict();
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, previous.workspaceId)).for("update");
    if (workspace && !workspace.terminalAt)
      throw new ApiError("operation.conflict", "Previous compute must be fenced first.");
    const pending = await tx
      .select()
      .from(tables.workspaceLeases)
      .where(pendingWorkspaceLeases(tables, previous.workspaceId));
    if (pending.length)
      throw new ApiError("operation.conflict", "Previous credentials must be revoked or recorded expired first.");
  }
  async function compatibleSiblings(
    tx: Transaction,
    id: ManagedSessionIdentity,
    binding: ManagedBinding,
    profile: Awaited<ReturnType<typeof auth.profile>>,
    producer: typeof tables.workspaces.$inferSelect.runtimeRegistration,
  ) {
    const siblings = await tx.select().from(sessions).where(eq(sessions.principalId, id.principalId));
    for (const sibling of siblings.filter(
      (s) => s.sessionId !== id.sessionId && s.binding?.workspaceId === binding.workspaceId,
    )) {
      const other = await auth.profile(tx, id.principalId, sibling.session.profileId, sibling.session.profileRevision);
      const a = managed.managedPlacement(id.principalId, id.sessionId, profile.profile);
      const b = managed.managedPlacement(id.principalId, sibling.sessionId, other.profile);
      if (a.mode !== "shared" || b.mode !== "shared" || a.key !== b.key) throw unavailable();
      const installed = producer?.producer;
      if (!installed) throw unavailable();
      if (!PARALLEL_CONVERSATION_CAPABILITIES.every((c) => installed.capabilities.includes(c))) throw unavailable();
      if (
        !Object.values(installed.adapters).every((adapter) =>
          PARALLEL_CONVERSATION_CAPABILITIES.every((c) => adapter.capabilities.includes(c)),
        )
      )
        throw unavailable();
    }
  }
  async function validate(
    tx: Transaction,
    id: ManagedSessionIdentity,
    session: managed.Session,
    binding: ManagedBinding,
    lastGeneration: number,
  ) {
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1 || binding.generation <= lastGeneration)
      throw conflict();
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, binding.workspaceId)).for("update");
    const profile = await auth.profile(tx, id.principalId, session.profileId, session.profileRevision);
    if (
      !workspace ||
      workspace.principalId !== id.principalId ||
      workspace.templateDigest !== profile.profile.templateDigest
    )
      throw unavailable();
    if (
      !["provisioning", "connected", "ready"].includes(workspace.state) ||
      workspace.runtimeRegistration?.incarnationId !== binding.incarnationId ||
      workspace.deadlineAt <= new Date() ||
      workspace.terminalAt ||
      workspace.purgeRequestedAt
    )
      throw unavailable();
    await auth.validateScopes(tx, id.principalId, profile.profile);
    for (const scopeId of profile.profile.budgetScopeIds) await policyOwner(context).latest(tx, scopeId);
    await compatibleSiblings(tx, id, binding, profile, workspace.runtimeRegistration);
  }
  return { previousFenced, validate };
}
