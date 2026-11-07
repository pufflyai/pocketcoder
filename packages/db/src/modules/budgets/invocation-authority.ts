import type {
  InvocationInput,
  InvocationRecord,
  ManagedInvocationIdentity,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext, unavailable } from "../managed/authority-context";

export function invocationAuthority(context: DatabaseContext) {
  const { tables } = context;
  const auth = authorityContext(context);
  async function session(tx: Transaction, identity: ManagedInvocationIdentity) {
    const { principalId, sessionId } = identity;
    const [principal] = await tx
      .select()
      .from(tables.principals)
      .where(eq(tables.principals.id, principalId))
      .for("update");
    if (!principal || principal.disabledAt) throw unavailable();
    const [session] = await tx
      .select()
      .from(tables.managedSessions)
      .where(and(eq(tables.managedSessions.principalId, principalId), eq(tables.managedSessions.sessionId, sessionId)))
      .for("update");
    if (!session || ["closed", "failed"].includes(session.session.state)) throw unavailable();
    const { profile } = await auth.profile(tx, principalId, session.session.profileId, session.session.profileRevision);
    await auth.validateScopes(tx, principalId, profile);
    const [template] = await tx
      .select()
      .from(tables.templates)
      .where(eq(tables.templates.digest, profile.templateDigest));
    if (!template || !principal.templateNames.some((name) => name === "*" || name === template.name))
      throw unavailable();
    return { session, profile };
  }
  async function workspace(tx: Transaction, workspaceId: string, incarnationId: string, at: Date) {
    const [workspace] = await tx
      .select()
      .from(tables.workspaces)
      .where(eq(tables.workspaces.id, workspaceId))
      .for("update");
    const [fence] = await tx
      .select()
      .from(tables.workspaceLeaseFences)
      .where(eq(tables.workspaceLeaseFences.workspaceId, workspaceId));
    if (
      fence ||
      !workspace ||
      workspace.state !== "ready" ||
      workspace.terminalAt ||
      workspace.purgeRequestedAt ||
      workspace.deadlineAt <= at ||
      workspace.runtimeRegistration?.incarnationId !== incarnationId
    )
      throw unavailable();
  }
  async function reserve(tx: Transaction, input: InvocationInput) {
    const authorized = await session(tx, input.identity);
    if (!authorized.profile.allowedModels.includes(input.model)) throw unavailable();
    return authorized;
  }
  async function send(tx: Transaction, record: InvocationRecord, at: Date) {
    const authorized = await session(tx, record.reservation.identity);
    const owner = authorized.session;
    if (
      owner.bindingRevision !== record.bindingRevision ||
      owner.binding?.workspaceId !== record.workspaceId ||
      owner.binding.generation !== record.generation
    )
      throw unavailable();
    await workspace(tx, record.workspaceId, record.incarnationId, at);
  }
  return { reserve, send, session, workspace };
}
