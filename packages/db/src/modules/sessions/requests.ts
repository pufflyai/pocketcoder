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
import { expireRequest, prepareManagedRequests } from "./request-dispatch";
import { pinSessionInputs } from "./request-inputs";
import { workAuthority } from "./work-authority";

export function createManagedRequests(context: DatabaseContext): ManagedRequestStore {
  const { db, tables } = context;
  const requests = tables.conversationRequests;
  const writer = sessionWriter(context);
  const authorize = workAuthority(context);
  const stops = managedStops(context);
  return {
    async refuse(authority, at) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const id = { principalId: authority.principalId, sessionId: authority.sessionId };
        const session = await writer.read(tx, id);
        if (
          session.binding?.generation !== authority.generation ||
          session.binding.incarnationId !== authority.incarnationId
        )
          return;
        if (session.close) return;
        await writer.update(tx, id, session.session.revision, "suspended", "credentials_refused");
        const rows = await tx
          .select()
          .from(requests)
          .where(and(eq(requests.principalId, id.principalId), eq(requests.conversationId, id.sessionId)));
        for (const row of rows)
          if (row.managed && row.managed.request.state !== "terminal" && !row.execution?.producerSendClaimedAt)
            await expireRequest(context, tx, row, at, "credentials_refused");
      });
    },
    completeCleanup: (workspaceId) => completeManagedCleanup(context, workspaceId),
    async accept(keyId, sessionId, input, limits) {
      input = managed.RequestInputSchema.parse(input);
      if (![limits.count, limits.bytes].every((value) => Number.isSafeInteger(value) && value > 0))
        throw new ApiError("validation.invalid", "Explicit queue limits are required.");
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        let { id, row, profile } = await authorize(tx, keyId, sessionId, "sessions:write");
        const key = and(
          eq(requests.principalId, id.principalId),
          eq(requests.conversationId, sessionId),
          eq(requests.requestId, input.requestId),
        );
        const fingerprint = managed.fingerprintRequest(input);
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
        if (row.session.reasonCode === "credentials_refused") {
          await writer.update(tx, id, row.session.revision, "provisioning", null);
          row = await writer.read(tx, id);
        }
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
          dispatchDeadline: new Date(at.getTime() + profile.dispatchDeadlineSeconds * 1000).toISOString(),
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
            cancel: null,
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
    cancel: (keyId, sessionId, requestId, at) => stops.cancel(keyId, sessionId, requestId, at),
    async prepare(at, seedBytes) {
      await stops.sweep(at);
      await prepareManagedRequests(context, at, seedBytes);
    },
  };
}
