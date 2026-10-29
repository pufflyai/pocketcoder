import { describe, expect, test } from "bun:test";
import type {
  ConversationFact,
  ConversationMessageIdentity,
  ConversationRequestIdentity,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageRow, Store } from "@pstdio/pocketcoder-runtime-contracts";
import { type StoreContractHarness, withStore } from "./store-fixture";

function requiredIdentity<T>(identity: T | null | undefined): T {
  if (!identity) throw new Error("conversation identity missing");
  return identity;
}

function requiredActivity(fact: ConversationFact | undefined) {
  if (fact?.type !== "activity_started") throw new Error("activity missing");
  return fact;
}

export function registerConversationIdentityContract(name: string, harness: StoreContractHarness) {
  // PC-115, 2026-10-13: the PostgreSQL adapter requires its disposable database;
  // implementation validation sets POCKETCODER_TEST_DATABASE_URL to run it.
  describe.skipIf(harness.enabled === false)(`${name} conversation identity`, () => {
    test.each(["external", "generic"] as const)(
      "reconciles %s requests across generations without changing accepted identities",
      async (authority) => {
        await withStore(harness, async ({ store, workspace }) => {
          const original = workspace();
          await store.insertWorkspace(original);
          const resumed = workspace({ originWorkspaceId: original.id });
          await store.insertWorkspace(resumed);
          const identity: ConversationRequestIdentity = {
            schema: "pocketcoder.conversation/v2",
            authority,
            conversation_id: "10000000-0000-4000-8000-000000000001",
            request_id: "10000000-0000-4000-8000-000000000002",
            turn_id: "10000000-0000-4000-8000-000000000003",
            request_fingerprint: "a".repeat(64),
          };
          const acceptedAt = new Date("2026-10-13T12:00:00Z");
          const message = {
            workspaceId: original.id,
            messageId: "event-1:1",
            role: "assistant" as const,
            content: "Answer",
            occurredAt: acceptedAt,
            metadata: {},
            createdAt: acceptedAt,
            identity: {
              ...identity,
              event_id: "10000000-0000-4000-8000-000000000007",
              message_id: "answer-1",
              sequence: 1,
              revision: 1,
              fact: {
                type: "activity_started" as const,
                activity_id: "10000000-0000-4000-8000-000000000011",
                kind: "tool" as const,
                label: "Read selected files",
                started_at: null,
              },
            },
          };
          expect(await store.isAcceptedTurn(original.id, identity)).toBe(false);
          const concurrent = await Promise.all([
            store.acceptConversationRequest(original.id, identity, acceptedAt),
            store.acceptConversationRequest(resumed.id, identity, acceptedAt),
          ]);
          expect(concurrent.map((result) => result.kind).sort()).toEqual(["accepted", "replayed"]);
          const accepted = concurrent.find((result) => result.kind === "accepted");
          if (!accepted) throw new Error("acceptance receipt missing");
          expect(accepted).toMatchObject({ kind: "accepted", request: { identity, acceptedAt } });
          expect(await store.acceptConversationRequest(resumed.id, identity, new Date("2026-10-13T12:01:00Z"))).toEqual(
            { kind: "replayed", request: accepted.request },
          );
          expect(await store.acceptConversationRequest(resumed.id, message.identity, acceptedAt)).toEqual({
            kind: "replayed",
            request: accepted.request,
          });
          expect(await store.isAcceptedTurn(resumed.id, message.identity)).toBe(true);
          await commitAcrossGenerations(store, original, resumed, identity, message, acceptedAt);
          for (const conflict of [
            { request_fingerprint: "b".repeat(64) },
            { turn_id: "10000000-0000-4000-8000-000000000004" },
            { authority: authority === "external" ? "generic" : "external" },
          ] as const) {
            expect(
              await store.acceptConversationRequest(resumed.id, { ...identity, ...conflict }, acceptedAt),
            ).toMatchObject({ kind: "conflict", request: accepted.request });
          }
          const otherConversation = { ...identity, conversation_id: "10000000-0000-4000-8000-000000000005" };
          expect(await store.acceptConversationRequest(resumed.id, otherConversation, acceptedAt)).toMatchObject({
            kind: "accepted",
            request: { identity: otherConversation },
          });
          const otherPrincipal = await store.createPrincipal("other-owner", ["admin"], []);
          const otherWorkspace = workspace({ principalId: otherPrincipal.id });
          await store.insertWorkspace(otherWorkspace);
          expect(await store.acceptConversationRequest(otherWorkspace.id, identity, acceptedAt)).toMatchObject({
            kind: "accepted",
            request: { identity },
          });
          for (const requestIdentity of [identity, { ...identity, request_fingerprint: "b".repeat(64) }]) {
            const receipt = await store.acceptConversationRequest(resumed.id, requestIdentity, acceptedAt);
            receipt.request.acceptedAt.setUTCFullYear(2030);
            expect(
              (await store.acceptConversationRequest(resumed.id, identity, new Date())).request.acceptedAt,
            ).toEqual(new Date("2026-10-13T12:00:00Z"));
          }
          accepted.request.acceptedAt.setUTCFullYear(2030);
          acceptedAt.setUTCFullYear(2031);
          expect((await store.acceptConversationRequest(resumed.id, identity, new Date())).request.acceptedAt).toEqual(
            new Date("2026-10-13T12:00:00Z"),
          );
        });
      },
    );
  });
}

// One turn in the original generation, the next in the resumed one, under one conversation.
async function commitAcrossGenerations(
  store: Store,
  original: { id: string; principalId: string },
  resumed: { id: string },
  identity: ConversationRequestIdentity,
  message: Omit<ConversationMessageRow, "workspaceId" | "createdAt"> & {
    identity: ConversationMessageIdentity & { fact: Extract<ConversationFact, { type: "activity_started" }> };
  },
  acceptedAt: Date,
) {
  const turn = {
    workspaceId: original.id,
    identity,
    status: "completed" as const,
    reason: null,
    messages: [message],
    startedAt: acceptedAt,
    endedAt: acceptedAt,
  };
  const committed = await store.commitConversationTurn(turn);
  expect(committed.created).toBe(true);
  const activity = requiredActivity(requiredIdentity(committed.record.document.messages[0]?.identity).fact);
  activity.label = "altered display label";
  expect(message.identity.fact.label).toBe("Read selected files");
  expect(await store.commitConversationTurn(turn)).toMatchObject({ created: false });
  const document = await store.getConversation(original.principalId, identity.conversation_id);
  if (!document) throw new Error("conversation document missing");
  expect(await store.readConversationMessages(document.id, 0, 10)).toEqual([
    expect.objectContaining({ seq: 1, identity: message.identity }),
  ]);
  const nextTurn = {
    ...identity,
    request_id: "10000000-0000-4000-8000-000000000008",
    turn_id: "10000000-0000-4000-8000-000000000009",
  };
  await store.acceptConversationRequest(resumed.id, nextTurn, acceptedAt);
  expect(
    await store.commitConversationTurn({
      ...turn,
      workspaceId: resumed.id,
      identity: nextTurn,
      messages: [{ ...message, identity: { ...message.identity, ...nextTurn } }],
    }),
  ).toMatchObject({ created: true });
  expect(
    (await store.readConversationMessages(document.id, 0, 10)).map((row) => [row.seq, row.identity?.turn_id]),
  ).toEqual([
    [1, identity.turn_id],
    [2, nextTurn.turn_id],
  ]);
  // The resumed generation lists the conversation its origin started.
  expect((await store.listConversations(resumed.id)).map((row) => row.conversationId)).toEqual([
    identity.conversation_id,
  ]);
}
