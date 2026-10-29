import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationRequestIdentity } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

type Fixture = Awaited<ReturnType<typeof createPGliteFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

async function open() {
  fixture = await createPGliteFixture("pc-conversations");
  return fixture;
}

async function turn(f: Fixture, workspaceId: string, conversationId: string, text: string) {
  const identity: ConversationRequestIdentity = {
    schema: "pocketcoder.conversation/v2",
    authority: "external",
    conversation_id: conversationId,
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "a".repeat(64),
  };
  await f.store.acceptConversationRequest(workspaceId, identity, new Date());
  const at = new Date();
  const message = (role: "user" | "assistant", content: string) => ({
    messageId: randomUUID(),
    role,
    content,
    occurredAt: at,
    metadata: {},
    identity: { ...identity, event_id: randomUUID(), message_id: randomUUID(), sequence: 0, revision: 1 },
  });
  return f.store.commitConversationTurn({
    workspaceId,
    identity,
    status: "completed",
    reason: null,
    messages: [message("user", `${text}?`), message("assistant", `${text}!`)],
    startedAt: at,
    endedAt: at,
  });
}

async function documentOf(f: Fixture, conversationId: string) {
  const document = await f.store.getConversation(f.principal.id, conversationId);
  if (!document) throw new Error("conversation missing");
  return document;
}

async function readAll(f: Fixture, conversationRef: string, page: number) {
  const messages = [];
  let after = 0;
  while (true) {
    const batch = await f.store.readConversationMessages(conversationRef, after, page);
    messages.push(...batch);
    if (batch.length < page) return messages;
    after = batch.at(-1)?.seq ?? after;
  }
}

test("hundreds of turns write one record each and read back in order", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "long");
  const conversation = randomUUID();
  for (let index = 0; index < 300; index++) {
    const { record, created } = await turn(f, workspace.id, conversation, `q${index}`);
    expect(created).toBe(true);
    expect([record.recordSeq, record.firstSeq, record.lastSeq]).toEqual([index + 1, 2 * index + 1, 2 * index + 2]);
  }
  const document = await documentOf(f, conversation);
  expect(document).toMatchObject({ recordCount: 300, messageCount: 600, lastSeq: 600 });
  const messages = await readAll(f, document.id, 37);
  expect(messages.map((message) => message.seq)).toEqual(Array.from({ length: 600 }, (_, index) => index + 1));
  expect(messages.at(-1)?.content).toBe("q299!");
}, 60_000);

test("interleaved conversations in one workspace keep separate histories", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "chats");
  const [a, b] = [randomUUID(), randomUUID()];
  for (const [conversation, text] of [
    [a, "a1"],
    [b, "b1"],
    [a, "a2"],
    [b, "b2"],
  ] as const)
    await turn(f, workspace.id, conversation, text);
  for (const [conversation, expected] of [
    [a, ["a1?", "a1!", "a2?", "a2!"]],
    [b, ["b1?", "b1!", "b2?", "b2!"]],
  ] as const) {
    const messages = await readAll(f, (await documentOf(f, conversation)).id, 10);
    expect(messages.map((message) => [message.seq, message.content])).toEqual(
      expected.map((content, index) => [index + 1, content]),
    );
  }
  expect((await f.store.listConversations(workspace.id)).map((row) => row.conversationId).sort()).toEqual(
    [a, b].sort(),
  );
  // The workspace view keeps the order the turns were written in.
  const workspaceView = await f.store.readWorkspaceConversation(workspace.id, 0, 3);
  expect(workspaceView.map((row) => row.message.content)).toEqual(["a1?", "a1!", "b1?"]);
  const rest = await f.store.readWorkspaceConversation(workspace.id, workspaceView.at(-1)?.position ?? 0, 10);
  expect(rest.map((row) => row.message.content)).toEqual(["b1!", "a2?", "a2!", "b2?", "b2!"]);
});

test("deleting one conversation leaves the others and refuses later writes", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "delete-one");
  const [kept, removed] = [randomUUID(), randomUUID()];
  await turn(f, workspace.id, kept, "keep");
  await turn(f, workspace.id, removed, "remove");
  expect(await f.store.deleteConversationById(f.principal.id, removed, new Date())).toBe(true);
  expect(await documentOf(f, removed)).toMatchObject({ status: "deleted", messageCount: 0 });
  expect(await f.store.readConversationMessages((await documentOf(f, removed)).id, 0, 10)).toEqual([]);
  expect(await readAll(f, (await documentOf(f, kept)).id, 10)).toHaveLength(2);
  await expect(turn(f, workspace.id, removed, "late")).rejects.toMatchObject({ code: "conversation.deleted" });
});

test("a restart records an accepted turn without a stored result as interrupted, once", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "restart");
  const conversation = randomUUID();
  await turn(f, workspace.id, conversation, "done");
  const identity: ConversationRequestIdentity = {
    schema: "pocketcoder.conversation/v2",
    authority: "external",
    conversation_id: conversation,
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "b".repeat(64),
  };
  await f.store.acceptConversationRequest(workspace.id, identity, new Date());
  expect(await f.store.recordInterruptedTurns(new Date())).toBe(1);
  expect(await f.store.recordInterruptedTurns(new Date())).toBe(0);
  const records = await f.store.readConversationRecords((await documentOf(f, conversation)).id);
  expect(records.map((record) => record.status)).toEqual(["completed", "interrupted"]);
  expect(records[1]?.recordKey).toBe(identity.turn_id);
  expect(records[1]?.document).toMatchObject({ reason: "controller_restarted" });
  // The outcome is part of the history, so readers see it instead of a gap.
  expect(records[1]?.document.messages.map((message) => message.identity?.fact)).toEqual([
    { type: "turn_terminal", outcome: "interrupted", reason: "controller_restarted" },
  ]);
});

test("retention starts when the last writing workspace ends and can keep history until deleted", async () => {
  const f = await open();
  const ended = await insertTestWorkspace(f, "ended");
  const kept = await insertTestWorkspace(f, "kept");
  const [expiring, forever] = [randomUUID(), randomUUID()];
  await turn(f, ended.id, expiring, "old");
  await turn(f, kept.id, forever, "kept");
  const terminalAt = new Date(Date.now() - 2 * 3_600_000);
  await f.query(`UPDATE ${f.schema}.workspaces SET terminal_at = $1`, [terminalAt]);
  const hour = 3_600_000;
  const retention = (workspace: { conversationRetention: string }) =>
    workspace.conversationRetention === "forever" ? null : hour;
  await f.query(
    `UPDATE ${f.schema}.workspaces SET template_snapshot = jsonb_set(template_snapshot, '{spec,persistence,conversationRetention}', '"forever"') WHERE id = $1`,
    [kept.id],
  );
  expect(await f.store.pruneExpiredConversations(new Date(), retention)).toBe(1);
  expect(await documentOf(f, expiring)).toMatchObject({ status: "expired", messageCount: 0 });
  expect(await documentOf(f, forever)).toMatchObject({ status: "retained", expiresAt: null, retentionSet: true });
  expect(await f.store.pruneExpiredConversations(new Date(), retention)).toBe(0);
});

test("messages without identity are single records of the workspace history", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "plain");
  const at = new Date();
  for (const id of ["agentapi:1", "agentapi:2", "agentapi:1"])
    await f.store.appendWorkspaceMessage({
      workspaceId: workspace.id,
      messageId: id,
      role: "assistant",
      content: id,
      occurredAt: at,
      metadata: {},
      createdAt: at,
    });
  const read = await f.store.readWorkspaceConversation(workspace.id, 0, 10);
  expect(read.map((row) => [row.message.seq, row.message.content])).toEqual([
    [1, "agentapi:1"],
    [2, "agentapi:2"],
  ]);
  const [document] = await f.store.listConversations(workspace.id);
  expect(document).toMatchObject({ conversationId: null, recordCount: 2, workspaceId: workspace.id });
});

test("interrupted turns between others never cut a page short", async () => {
  const f = await open();
  const workspace = await insertTestWorkspace(f, "gaps");
  const conversation = randomUUID();
  await turn(f, workspace.id, conversation, "before");
  for (let index = 0; index < 3; index++)
    await f.store.acceptConversationRequest(
      workspace.id,
      {
        schema: "pocketcoder.conversation/v2",
        authority: "external",
        conversation_id: conversation,
        request_id: randomUUID(),
        turn_id: randomUUID(),
        request_fingerprint: "d".repeat(64),
      },
      new Date(),
    );
  expect(await f.store.recordInterruptedTurns(new Date())).toBe(3);
  await turn(f, workspace.id, conversation, "after");
  const messages = await readAll(f, (await documentOf(f, conversation)).id, 2);
  expect(messages.map((message) => message.content)).toEqual(["before?", "before!", "", "", "", "after?", "after!"]);
  const view = [];
  let position = 0;
  while (true) {
    const page = await f.store.readWorkspaceConversation(workspace.id, position, 2);
    view.push(...page);
    if (page.length < 2) break;
    position = page.at(-1)?.position ?? position;
  }
  expect(view).toHaveLength(7);
});
