import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedGatewayGrantStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const denied = () => new ApiError("auth.invalid_key", "Gateway credential is not valid for this call.");

// Workspace-readable model gateway credentials. A token proves one workspace incarnation; the
// controller maps the producer's physical turn to its logical request, so standing provider keys,
// budget scopes and models never come from workspace-supplied fields.
export function createGatewayGrants(context: DatabaseContext): ManagedGatewayGrantStore {
  const { db, tables } = context;
  const grants = tables.modelGatewayGrants;
  const auth = authorityContext(context);
  // Compute placed for a session that has since closed never receives model authority.
  async function closedPlacement(tx: Transaction, workspace: typeof tables.workspaces.$inferSelect) {
    const sessionId = workspace.metadata[managed.MANAGED_SESSION_METADATA];
    if (!sessionId) return false;
    const [session] = await tx
      .select({ session: tables.managedSessions.session })
      .from(tables.managedSessions)
      .where(
        and(
          eq(tables.managedSessions.principalId, workspace.principalId),
          eq(tables.managedSessions.sessionId, sessionId),
        ),
      );
    return session?.session.state === "closed";
  }
  return {
    // Each registration mints a fresh grant and revokes the earlier ones, so a lost delivery
    // never leaves a second valid copy behind.
    async issue(workspaceId, incarnationId, at) {
      return db.transaction(async (tx) => {
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, workspaceId))
          .for("update");
        if (
          !workspace ||
          workspace.terminalAt ||
          workspace.purgeRequestedAt ||
          workspace.runtimeRegistration?.endedAt ||
          workspace.runtimeRegistration?.incarnationId !== incarnationId ||
          workspace.deadlineAt <= at ||
          (await closedPlacement(tx, workspace))
        )
          throw new ApiError("secret.unavailable", "Workspace cannot receive gateway credentials.");
        await tx
          .update(grants)
          .set({ revokedAt: at })
          .where(and(eq(grants.workspaceId, workspaceId), isNull(grants.revokedAt)));
        const token = randomBytes(32).toString("base64url");
        const expiresAt = workspace.deadlineAt;
        await tx.insert(grants).values({
          id: randomUUID(),
          tokenDigest: digest(token),
          principalId: workspace.principalId,
          workspaceId,
          incarnationId,
          expiresAt,
          createdAt: at,
        });
        return { token, expiresAt };
      });
    },
    async resolve(token, turnId, at) {
      return db.transaction(async (tx) => {
        const [grant] = await tx
          .select()
          .from(grants)
          .where(eq(grants.tokenDigest, digest(token)));
        if (!grant || grant.revokedAt || grant.expiresAt <= at || !turnId) throw denied();
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, grant.workspaceId));
        const runtime = workspace?.runtimeRegistration;
        if (
          !workspace ||
          workspace.state !== "ready" ||
          workspace.terminalAt ||
          runtime?.endedAt ||
          runtime?.incarnationId !== grant.incarnationId
        )
          throw denied();
        const requests = tables.conversationRequests;
        const [row] = await tx
          .select()
          .from(requests)
          .where(and(eq(requests.principalId, grant.principalId), sql`${requests.identity}->>'turn_id' = ${turnId}`));
        const physical = row?.managed?.physicalExecution;
        // The turn must run on this exact workspace incarnation and still be unfinished.
        if (
          !row?.managed ||
          physical?.workspaceId !== grant.workspaceId ||
          physical.incarnationId !== grant.incarnationId ||
          row.managed.request.state === "terminal" ||
          row.managed.cancel
        )
          throw denied();
        const [session] = await tx
          .select()
          .from(tables.managedSessions)
          .where(
            and(
              eq(tables.managedSessions.principalId, grant.principalId),
              eq(tables.managedSessions.sessionId, row.conversationId),
            ),
          );
        const binding = session?.binding;
        if (
          !session ||
          session.session.state === "closed" ||
          binding?.workspaceId !== grant.workspaceId ||
          binding.incarnationId !== grant.incarnationId
        )
          throw denied();
        const { profile } = await auth.profile(
          tx,
          grant.principalId,
          session.session.profileId,
          session.session.profileRevision,
        );
        return {
          identity: { principalId: grant.principalId, sessionId: row.conversationId, requestId: row.requestId },
          workspaceId: grant.workspaceId,
          incarnationId: grant.incarnationId,
          generation: binding.generation,
          allowedModels: profile.allowedModels,
        };
      });
    },
  };
}
