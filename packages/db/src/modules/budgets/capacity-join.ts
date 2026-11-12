import { type InstalledWorkload, managed, PARALLEL_CONVERSATION_CAPABILITIES } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";

export const parallel = (producer: InstalledWorkload | null | undefined) =>
  Boolean(
    producer &&
      PARALLEL_CONVERSATION_CAPABILITIES.every((c) => producer.capabilities.includes(c)) &&
      Object.values(producer.adapters).every((a) =>
        PARALLEL_CONVERSATION_CAPABILITIES.every((c) => a.capabilities.includes(c)),
      ),
  );

export async function joinableWorkspace(context: DatabaseContext, id: ManagedSessionIdentity) {
  return context.db.transaction(async (tx) => {
    const session = await sessionWriter(context).read(tx, id);
    const { profile } = await authorityContext(context).profile(tx, id.principalId, session.session.profile);
    const placement = managed.managedPlacement(id.principalId, session.session, profile);
    if (placement.mode !== "shared") return null;
    const rows = await tx.select().from(context.tables.managedCapacity);
    const workspaces = await tx
      .select()
      .from(context.tables.workspaces)
      .where(eq(context.tables.workspaces.principalId, id.principalId));
    return (
      rows
        .filter(
          (r) =>
            r.record.placementKey === placement.key &&
            r.record.state !== "released" &&
            !r.record.drainingAt &&
            r.record.sessions.filter((s) => !s.stoppedAt).length < profile.limits.sessionsPerWorkspace,
        )
        .filter((r) =>
          workspaces.some(
            (w) =>
              w.id === r.workspaceId &&
              !w.terminalAt &&
              !w.purgeRequestedAt &&
              !w.runtimeRegistration?.endedAt &&
              parallel(w.runtimeRegistration?.producer),
          ),
        )
        .sort((a, b) => b.record.sessions.length - a.record.sessions.length)[0]?.workspaceId ?? null
    );
  });
}
