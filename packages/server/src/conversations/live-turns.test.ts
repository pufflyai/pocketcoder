import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationFact, ConversationLiveEvent } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { LiveTurns } from "./live-turns";

type Fixture = Awaited<ReturnType<typeof createPGliteFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

async function setup() {
  fixture = await createPGliteFixture("pc-live-turns");
  const workspace = await insertTestWorkspace(fixture, "live");
  const request = {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: randomUUID(),
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "a".repeat(64),
  };
  await fixture.store.acceptConversationRequest(workspace.id, request, new Date());
  const live = new LiveTurns(fixture.store);
  const events: ConversationLiveEvent[] = [];
  live.subscribe(workspace.id, (event) => events.push(event));
  const send = (event: string, revision: number, content: string, fact?: ConversationFact) =>
    live.receive(workspace.id, {
      message_id: `m-${event}`,
      role: "assistant",
      content,
      occurred_at: new Date().toISOString(),
      metadata: {},
      identity: {
        ...request,
        event_id: event,
        message_id: `m-${event}`,
        sequence: 0,
        revision,
        ...(fact ? { fact } : {}),
      },
    });
  return { f: fixture, workspace, request, live, events, send };
}

test("streamed revisions stay in memory and the turn is written once at its end", async () => {
  const { f, request, events, send } = await setup();
  const answer = randomUUID();
  await send(answer, 1, "Dra");
  await send(answer, 2, "Draft answer");
  await send(answer, 1, "stale revision");
  expect(await f.store.getConversation(f.principal.id, request.conversation_id)).toBeNull();
  await send(randomUUID(), 1, "", { type: "turn_terminal", outcome: "completed", reason: "done" });
  const document = await f.store.getConversation(f.principal.id, request.conversation_id);
  expect(document).toMatchObject({ recordCount: 1, messageCount: 2 });
  const [record] = await f.store.readConversationRecords(document?.id ?? "");
  expect(record).toMatchObject({ status: "completed", document: { reason: "done" } });
  expect(record?.document.messages.map((message) => message.content)).toEqual(["Draft answer", ""]);
  expect(events.map((event) => event.type)).toEqual(["turn", "turn", "turn", "committed"]);
  expect(events.at(-1)).toMatchObject({ type: "committed", status: "completed", last_seq: 2 });
});

test("a turn from a request nobody accepted is rejected", async () => {
  const { live, workspace } = await setup();
  const stranger = {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: randomUUID(),
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "b".repeat(64),
  };
  await expect(
    live.receive(workspace.id, {
      message_id: "x",
      role: "assistant",
      content: "x",
      occurred_at: new Date().toISOString(),
      metadata: {},
      identity: { ...stranger, event_id: randomUUID(), message_id: "x", sequence: 0, revision: 1 },
    }),
  ).rejects.toThrow("conversation.request_not_accepted");
});

test("an open turn is recorded as interrupted when its workspace ends", async () => {
  const { f, request, live, workspace, send } = await setup();
  await send(randomUUID(), 1, "partial");
  expect(live.open(workspace.id)).toHaveLength(1);
  await live.close(workspace.id, new Date());
  const document = await f.store.getConversation(f.principal.id, request.conversation_id);
  const [record] = await f.store.readConversationRecords(document?.id ?? "");
  expect(record).toMatchObject({ status: "interrupted", document: { reason: "workspace_ended" } });
  expect(record?.document.messages.map((message) => message.content)).toEqual(["partial", ""]);
  expect(record?.document.messages[1]?.identity?.fact).toEqual({
    type: "turn_terminal",
    outcome: "interrupted",
    reason: "workspace_ended",
  });
  expect(live.open(workspace.id)).toEqual([]);
});

test("a turn whose write fails for a passing reason stays open and is written later", async () => {
  const { f, request, workspace, send } = await setup();
  let failures = 1;
  const flaky = new LiveTurns({
    isAcceptedTurn: (...args) => f.store.isAcceptedTurn(...args),
    commitConversationTurn: async (turn) => {
      if (failures-- > 0) throw new Error("connection reset");
      return f.store.commitConversationTurn(turn);
    },
  });
  const message = (event: string, content: string, fact?: ConversationFact) => ({
    message_id: event,
    role: "assistant" as const,
    content,
    occurred_at: new Date().toISOString(),
    metadata: {},
    identity: { ...request, event_id: event, message_id: event, sequence: 0, revision: 1, ...(fact ? { fact } : {}) },
  });
  await flaky.receive(workspace.id, message(randomUUID(), "kept"));
  await expect(
    flaky.receive(workspace.id, message(randomUUID(), "", { type: "turn_terminal", outcome: "completed" })),
  ).rejects.toThrow("connection reset");
  expect(flaky.open(workspace.id)).toHaveLength(1);
  await flaky.close(workspace.id, new Date());
  const document = await f.store.getConversation(f.principal.id, request.conversation_id);
  const [record] = await f.store.readConversationRecords(document?.id ?? "");
  // The terminal fact had arrived, so the retry keeps its outcome.
  expect(record).toMatchObject({ status: "completed" });
  expect(record?.document.messages.map((item) => item.content)).toEqual(["kept", ""]);
  void send;
});

test("an open turn cannot grow past the conversation size limit", async () => {
  const { live, workspace, send } = await setup();
  await send(randomUUID(), 1, "x".repeat(30 * 1024 * 1024));
  await expect(send(randomUUID(), 1, "y".repeat(30 * 1024 * 1024))).rejects.toThrow("conversation.quota_exceeded");
  expect(live.open(workspace.id)[0]?.messages).toHaveLength(1);
});
