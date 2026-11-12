import { randomUUID } from "node:crypto";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { placeManagedCapacity } from "../budgets/capacity-placement";
import { authorityContext, conflict, unavailable } from "../managed/authority-context";
import { sessionWriter } from "./observations";
import { placementChecks } from "./placement";
import { managedStops } from "./request-cancel";
import { workAuthority } from "./work-authority";

export function createManagedSessions(context: DatabaseContext): ManagedSessionStore {
  const { db, tables } = context;
  const { managedSessions: sessions, principals } = tables;
  const auth = authorityContext(context);
  const writer = sessionWriter(context);
  const placement = placementChecks(context);
  const stops = managedStops(context);
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
          (known.session.profile !== parsed.profile ||
            known.session.owner !== parsed.owner ||
            known.session.group !== (parsed.group ?? parsed.owner))
        )
          throw conflict();
        const profile = await auth.profile(tx, id.principalId, parsed.profile);
        const [template] = await tx
          .select()
          .from(tables.templates)
          .where(eq(tables.templates.digest, profile.profile.templateDigest));
        if (!template || !actor.authority.templateNames.some((name) => name === "*" || name === template.name))
          throw unavailable();
        if (known) return known.session;
        if (profile.profile.disabled) throw unavailable();
        const at = new Date().toISOString();
        const session: managed.Session = {
          ...parsed,
          group: parsed.group ?? parsed.owner,
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
        const { row } = await workAuthority(context)(tx, keyId, sessionId, "sessions:read");
        return row.session;
      });
    },
    async list(keyId, filters) {
      return db.transaction(async (tx) => {
        const actor = await auth.caller(tx, keyId, "sessions:read");
        const rows = await tx.select().from(sessions).where(eq(sessions.principalId, actor.authority.principalId));
        const profiles = await tx
          .select()
          .from(tables.managedProfiles)
          .where(eq(tables.managedProfiles.principalId, actor.authority.principalId));
        const allowed = new Set(
          profiles
            .filter((p) => actor.authority.templateNames.some((name) => name === "*" || name === p.template))
            .map((p) => p.name),
        );
        const r = tables.conversationRequests;
        const active = await tx
          .select()
          .from(r)
          .where(and(eq(r.principalId, actor.authority.principalId), isNotNull(r.managed)));
        return rows
          .filter(
            ({ session }) =>
              allowed.has(session.profile) &&
              (!filters.owner || session.owner === filters.owner) &&
              (!filters.state ||
                (filters.state === "open" ? session.state !== "closed" : session.state === filters.state)),
          )
          .map(({ session }) => ({
            ...session,
            activeRequestId:
              active.find((r) => r.conversationId === session.sessionId && r.managed?.request.state === "running")
                ?.requestId ?? null,
          }));
      });
    },
    async bind(id, expectedRevision, binding) {
      return db.transaction(async (tx) => {
        const [principal] = await tx.select().from(principals).where(eq(principals.id, id.principalId)).for("update");
        if (!principal || principal.disabledAt) throw unavailable();
        const row = await writer.read(tx, id);
        if (row.bindingRevision !== expectedRevision) throw new ApiError("revision.stale", "Binding revision changed.");
        if (row.session.state === "closed") throw new ApiError("session.closed", "Session has ended.");
        await placement.previousFenced(tx, row.binding, binding);
        if (binding) {
          await placeManagedCapacity(context, tx, {
            ...id,
            workspaceId: binding.workspaceId,
            generation: binding.generation,
          });
          await placement.validate(tx, id, row.session, binding, row.lastGeneration);
        }
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
    close: (keyId, sessionId, at) => stops.close(keyId, sessionId, at),
    cancel: (keyId, sessionId, at) => stops.cancelSession(keyId, sessionId, at),
    async binding(keyId, sessionId) {
      return db.transaction(async (tx) => {
        const { row } = await workAuthority(context)(tx, keyId, sessionId, "sessions:read");
        return row.binding ? { ...row.binding, bindingRevision: row.bindingRevision } : null;
      });
    },
  };
}
