import { type InstalledWorkload, managed, PARALLEL_CONVERSATION_CAPABILITIES } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";
import { policyOwner } from "./policy-owner";

// A live workspace this session may share: one it already holds, else the fullest one with the same
// placement key and room under every scope. Placement still re-checks room under the scope locks,
// so a racing join fails there and the next tick looks again.
export async function joinableWorkspace(context: DatabaseContext, id: ManagedSessionIdentity) {
  const { db, tables } = context;
  return db.transaction(async (tx) => {
    const session = await sessionWriter(context).read(tx, id);
    const profile = await authorityContext(context).profile(
      tx,
      id.principalId,
      session.session.profileId,
      session.session.profileRevision,
    );
    const placement = managed.managedPlacement(id.principalId, id.sessionId, profile.profile);
    if (placement.mode !== "shared") return null;
    let limit = Number.MAX_SAFE_INTEGER;
    for (const scopeId of profile.profile.budgetScopeIds)
      limit = Math.min(limit, (await policyOwner(context).latest(tx, scopeId)).limits.maxChatProcessesPerWorkspace);
    const workspaces = await tx
      .select()
      .from(tables.workspaces)
      .where(eq(tables.workspaces.principalId, id.principalId));
    // A template digest pins the image, so any registered workspace of it shows what a booting one runs.
    const evidence = workspaces.find(
      (workspace) =>
        workspace.templateDigest === profile.profile.templateDigest && workspace.runtimeRegistration?.producer,
    )?.runtimeRegistration?.producer;
    const live = (workspaceId: string) => {
      const row = workspaces.find((workspace) => workspace.id === workspaceId);
      return Boolean(
        row &&
          parallel(row.runtimeRegistration?.producer ?? evidence) &&
          !row.terminalAt &&
          !row.purgeRequestedAt &&
          !row.runtimeRegistration?.endedAt &&
          ["queued", "provisioning", "connected", "ready"].includes(row.state),
      );
    };
    const candidates = (await tx.select().from(tables.managedCapacity))
      .filter(({ record }) => record.state !== "released" && record.placementKey === placement.key)
      .filter(({ workspaceId }) => live(workspaceId))
      .map(({ workspaceId, record }) => ({
        workspaceId,
        running: record.sessions.filter((s) => !s.stoppedAt),
      }));
    const held = candidates.find(({ running }) => running.some((s) => s.sessionId === id.sessionId));
    if (held) return held.workspaceId;
    const open = candidates.filter(({ running }) => running.length < limit);
    return open.sort((a, b) => b.running.length - a.running.length)[0]?.workspaceId ?? null;
  });
}

const parallel = (producer: InstalledWorkload | null | undefined) =>
  Boolean(
    producer &&
      PARALLEL_CONVERSATION_CAPABILITIES.every((c) => producer.capabilities.includes(c)) &&
      Object.values(producer.adapters).every((adapter) =>
        PARALLEL_CONVERSATION_CAPABILITIES.every((c) => adapter.capabilities.includes(c)),
      ),
  );
