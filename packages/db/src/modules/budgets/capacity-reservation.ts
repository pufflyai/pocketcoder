import { randomUUID } from "node:crypto";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext, unavailable } from "../managed/authority-context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { sessionWriter } from "../sessions/observations";
import { placeManagedCapacity } from "./capacity-placement";
import { idleVictim, launchingCandidate, sharedCandidate } from "./capacity-selection";

// The reservation and placement intent commit together, before any provider work. A restart
// creates the same workspace ID; concurrent sessions see this reservation and wait for it.
export async function reserveManagedPlacement(
  context: DatabaseContext,
  id: ManagedSessionIdentity,
  generation: number,
  at: Date,
) {
  const { db, tables } = context,
    capacity = tables.managedCapacity;
  return db.transaction(async (tx) => {
    await lockStorageCapacity(context, tx);
    const [principal] = await tx
      .select()
      .from(tables.principals)
      .where(eq(tables.principals.id, id.principalId))
      .for("update");
    if (!principal || principal.disabledAt) throw unavailable();
    const writer = sessionWriter(context),
      session = await writer.read(tx, id);
    if (session.close) return null;
    if (session.placement) return session.placement;
    if (session.binding || generation !== session.lastGeneration + 1) return null;
    const { profile } = await authorityContext(context).profile(tx, id.principalId, session.session.profile);
    const placement = managed.managedPlacement(id.principalId, session.session, profile);
    const owned = (await tx.select().from(capacity)).filter(
      (r) =>
        r.record.principalId === id.principalId &&
        r.record.profile === session.session.profile &&
        r.record.owner === session.session.owner &&
        r.record.state !== "released",
    );
    const workspaces = await tx
      .select()
      .from(tables.workspaces)
      .where(eq(tables.workspaces.principalId, id.principalId));
    const available = owned.filter((r) => !r.record.drainingAt && r.record.placementKey === placement.key);
    const workspaceId =
      placement.mode === "shared"
        ? sharedCandidate(available, workspaces, profile.limits.sessionsPerWorkspace)
        : undefined;
    if (
      !workspaceId &&
      placement.mode === "shared" &&
      profile.limits.sessionsPerWorkspace > 1 &&
      launchingCandidate(available, workspaces)
    )
      return null;
    if (!workspaceId && owned.length >= profile.limits.workspacesPerOwner) {
      await beginOwnerDrain(context, tx, id, owned, workspaces, profile.templateDigest, session.session.group, at);
      return null;
    }
    const selected = workspaceId ?? randomUUID();
    await placeManagedCapacity(context, tx, { ...id, workspaceId: selected, generation });
    const intent = {
      workspaceId: selected,
      generation,
      requestedAt: at.toISOString(),
      templateName: profile.template,
      templateVersion: profile.templateVersion!,
      templateDigest: profile.templateDigest,
    };
    await tx.update(tables.managedSessions).set({ placement: intent }).where(writer.where(id));
    return intent;
  });
}

async function beginOwnerDrain(
  context: DatabaseContext,
  tx: Transaction,
  id: ManagedSessionIdentity,
  owned: DatabaseContext["tables"]["managedCapacity"]["$inferSelect"][],
  workspaces: DatabaseContext["tables"]["workspaces"]["$inferSelect"][],
  templateDigest: string,
  group: string,
  at: Date,
) {
  const { tables } = context,
    capacity = tables.managedCapacity,
    writer = sessionWriter(context);
  const requests = await tx.select().from(tables.conversationRequests);
  const victim = idleVictim(owned, workspaces, requests, templateDigest, group);
  if (!victim) return;
  await tx
    .update(capacity)
    .set({ record: { ...victim.record, drainingAt: at.toISOString() } })
    .where(eq(capacity.workspaceId, victim.workspaceId));
  for (const participant of victim.record.sessions.filter((s) => !s.stoppedAt)) {
    const identity = { principalId: id.principalId, sessionId: participant.sessionId },
      row = await writer.read(tx, identity);
    if (row.session.state !== "closed" && row.session.state !== "suspended")
      await writer.update(tx, identity, row.session.revision, "suspended", "workspace_draining");
  }
}
