import { randomUUID } from "node:crypto";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedRequestStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { sessionWriter } from "./observations";
import { managedStops } from "./request-cancel";
import { completeManagedCleanup } from "./request-cleanup";
import { availableCollection } from "./request-collection";
import { prepareManagedRequests } from "./request-dispatch";
import { pinSessionInputs } from "./request-inputs";
import { writeManagedRequest } from "./request-writer";
import { workAuthority } from "./work-authority";

export function createManagedRequests(context: DatabaseContext): ManagedRequestStore {
  const { db, tables } = context;
  const requests = tables.conversationRequests;
  const writer = sessionWriter(context);
  const authorize = workAuthority(context);
  const stops = managedStops(context);
  return {
    completeCleanup: (workspaceId) => completeManagedCleanup(context, workspaceId),
    async accept(keyId, sessionId, input, limits) {
      input = managed.RequestInputSchema.parse(input);
      if (![limits.count, limits.bytes].every((value) => Number.isSafeInteger(value) && value > 0))
        throw new ApiError("validation.invalid", "Explicit queue limits are required.");
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:write");
        const key = and(
          eq(requests.principalId, id.principalId),
          eq(requests.conversationId, sessionId),
          eq(requests.requestId, input.requestId),
        );
        const fingerprint = managed.fingerprintRequest({
          ...input,
          sessionId,
          profileId: row.session.profileId,
          profileRevision: row.session.profileRevision,
        });
        const [known] = await tx.select().from(requests).where(key);
        if (known) {
          if (known.managed?.request.inputFingerprint !== fingerprint)
            throw new ApiError("idempotency.conflict", "Request identity changed.");
          return {
            replayed: true,
            request: {
              ...known.managed.request,
              collection: await availableCollection(context, tx, known.managed.request.collection),
            },
          };
        }
        const at = new Date();
        if (new Date(input.dispatchDeadline) <= at)
          throw new ApiError("validation.invalid", "Dispatch deadline has expired.");
        const bytes = Buffer.byteLength(JSON.stringify(input));
        if (row.queueCount >= limits.count || row.queueBytes + bytes > limits.bytes)
          throw new ApiError("capacity.queue_full", "Session queue is full.");
        await pinSessionInputs(context, tx, id, input.attachments, at);
        const turnId = randomUUID();
        const request = managed.RequestSchema.parse({
          sessionId,
          requestId: input.requestId,
          turnId,
          inputFingerprint: fingerprint,
          revision: 1,
          state: "accepted",
          outcome: null,
          reasonCode: null,
          acceptedAt: at.toISOString(),
          startedAt: null,
          endedAt: null,
          dispatchDeadline: input.dispatchDeadline,
          finalResponse: null,
          collection: {
            sessionId,
            requestId: input.requestId,
            revision: 1,
            state: "pending",
            completeness: null,
            manifestDigest: null,
            objects: [],
            errors: [],
            settledAt: null,
            expiresAt: null,
            cleanupState: "not_required",
          },
        });
        await tx.insert(requests).values({
          ...id,
          conversationId: sessionId,
          requestId: input.requestId,
          acceptedAt: at,
          identity: {
            schema: "pocketcoder.conversation/v2",
            authority: "generic",
            conversation_id: sessionId,
            request_id: input.requestId,
            turn_id: turnId,
            request_fingerprint: fingerprint.slice(7),
          },
          managed: {
            keyId,
            input,
            request,
            sequence: row.nextRequestSequence,
            queueBytes: bytes,
            queueReleased: false,
            bindingRevision: null,
          },
        });
        await tx
          .update(tables.managedSessions)
          .set({
            nextRequestSequence: row.nextRequestSequence + 1,
            queueCount: row.queueCount + 1,
            queueBytes: row.queueBytes + bytes,
          })
          .where(writer.where(id));
        await writer.append(tx, id, {
          eventId: randomUUID(),
          cursor: `${sessionId}:${row.nextSequence}`,
          sessionId,
          requestId: input.requestId,
          sequence: row.nextSequence,
          revision: 1,
          occurredAt: at.toISOString(),
          recordedAt: at.toISOString(),
          kind: "request.updated",
          data: request,
        });
        return { replayed: false, request };
      });
    },
    async get(keyId, sessionId, requestId) {
      return db.transaction(async (tx) => {
        const { id } = await authorize(tx, keyId, sessionId, "sessions:read");
        const [row] = await tx
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.principalId, id.principalId),
              eq(requests.conversationId, sessionId),
              eq(requests.requestId, requestId),
            ),
          );
        if (!row?.managed) throw new ApiError("request.not_found", "Unknown request.");
        return {
          ...row.managed.request,
          collection: await availableCollection(context, tx, row.managed.request.collection),
        };
      });
    },
    cancel: (keyId, sessionId, requestId, command, windowMs, at) =>
      stops.cancel(keyId, sessionId, requestId, command, windowMs, at),
    async budgetDenied(identity, at) {
      await db.transaction(async (tx) => {
        await writer.read(tx, identity);
        const [row] = await tx
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.principalId, identity.principalId),
              eq(requests.conversationId, identity.sessionId),
              eq(requests.requestId, identity.requestId),
            ),
          );
        if (!row?.managed || row.managed.budgetExhaustedAt || row.managed.request.state === "terminal") return;
        await writeManagedRequest(context, tx, row, { ...row.managed, budgetExhaustedAt: at.toISOString() });
      });
    },
    async prepare(at) {
      await stops.sweep(at);
      await prepareManagedRequests(context, at);
    },
  };
}
