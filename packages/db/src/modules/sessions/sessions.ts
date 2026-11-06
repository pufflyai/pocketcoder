import { randomUUID } from "node:crypto";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionStore } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { authorityContext, conflict, unavailable } from "../managed/authority-context";
import { sessionWriter } from "./observations";
import { placementChecks } from "./placement";

export function createManagedSessions(context: DatabaseContext): ManagedSessionStore {
  const { db, tables } = context;
  const { managedSessions: sessions, principals } = tables;
  const auth = authorityContext(context);
  const writer = sessionWriter(context);
  const placement = placementChecks(context);
  return {
    async create(keyId, input) {
      const parsed = managed.SessionCreateSchema.parse(input);
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "sessions:write");
        const id = { principalId: actor.authority.principalId, sessionId: parsed.sessionId };
        await lock(tx, `${id.principalId}:${id.sessionId}`, 33);
        const [known] = await tx.select().from(sessions).where(writer.where(id));
        if (
          known &&
          (known.session.profileId !== parsed.profileId || known.session.profileRevision !== parsed.profileRevision)
        )
          throw conflict();
        const profile = await auth.profile(tx, id.principalId, parsed.profileId, parsed.profileRevision);
        await auth.validateScopes(tx, id.principalId, profile.profile);
        const [template] = await tx
          .select()
          .from(tables.templates)
          .where(eq(tables.templates.digest, profile.profile.templateDigest));
        if (!template || !actor.authority.templateNames.some((name) => name === "*" || name === template.name))
          throw unavailable();
        if (known) return known.session;
        const at = new Date().toISOString();
        const session: managed.Session = {
          ...parsed,
          revision: 1,
          state: "provisioning",
          reasonCode: null,
          createdAt: at,
          updatedAt: at,
        };
        // The existing conversation owner creates transcript bytes on its first record.
        // The public session ID is also its canonical conversation ID, with no compute dependency.
        await writer.insert(tx, { ...id, conversationId: parsed.sessionId, session });
        await writer.append(tx, id, {
          eventId: randomUUID(),
          cursor: `${id.sessionId}:1`,
          sessionId: id.sessionId,
          requestId: null,
          sequence: 1,
          revision: 1,
          occurredAt: at,
          recordedAt: at,
          kind: "session.updated",
          data: session,
        });
        return session;
      });
    },
    async get(keyId, sessionId) {
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "sessions:read");
        const row = await writer.read(tx, { principalId: actor.authority.principalId, sessionId });
        const profile = await auth.profile(
          tx,
          actor.authority.principalId,
          row.session.profileId,
          row.session.profileRevision,
        );
        await auth.validateScopes(tx, actor.authority.principalId, profile.profile);
        const [template] = await tx
          .select()
          .from(tables.templates)
          .where(eq(tables.templates.digest, profile.profile.templateDigest));
        if (!template || !actor.authority.templateNames.some((name) => name === "*" || name === template.name))
          throw unavailable();
        return row.session;
      });
    },
    async bind(id, expectedRevision, binding) {
      return db.transaction(async (tx) => {
        const [principal] = await tx.select().from(principals).where(eq(principals.id, id.principalId)).for("update");
        if (!principal || principal.disabledAt) throw unavailable();
        const row = await writer.read(tx, id);
        if (row.bindingRevision !== expectedRevision) throw new ApiError("revision.stale", "Binding revision changed.");
        if (["closed", "failed"].includes(row.session.state))
          throw new ApiError("session.closed", "Session has ended.");
        await placement.previousFenced(tx, row.binding, binding);
        if (binding) await placement.validate(tx, id, row.session, binding, row.lastGeneration);
        await tx
          .update(sessions)
          .set({
            binding,
            bindingRevision: expectedRevision + 1,
            lastGeneration: binding?.generation ?? row.lastGeneration,
          })
          .where(writer.where(id));
        await writer.update(tx, id, row.session.revision, binding ? "provisioning" : "suspended", null);
        return expectedRevision + 1;
      });
    },
    async appendObservation(id, revision, state, reason) {
      return db.transaction((tx) => writer.update(tx, id, revision, state, reason));
    },
  };
}
