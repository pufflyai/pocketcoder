import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";
import { convertLegacyConversations } from "./legacy-conversion";

type Fixture = Awaited<ReturnType<typeof createPGliteFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

// Rows exactly as 0.8.x and the 1.0 candidates wrote them: one row per streamed revision.
async function legacyRow(f: Fixture, workspaceId: string, seq: number, content: string, identity: object | null) {
  await f.query(
    `INSERT INTO ${f.schema}.workspace_conversation_messages
      (workspace_id, seq, message_id, role, content, occurred_at, metadata, identity, created_at)
      VALUES ($1, $2, $3, 'assistant', $4, now(), '{}', CAST($5 AS text)::jsonb, now())`,
    [workspaceId, seq, `legacy-${seq}`, content, identity === null ? null : JSON.stringify(identity)],
  );
}

test("legacy rows become documents once: identified turns by conversation, the rest as a flagged legacy document", async () => {
  fixture = await createPGliteFixture("pc-legacy-conversion");
  const f = fixture;
  const workspace = await insertTestWorkspace(f, "legacy");
  const request = {
    schema: "pocketcoder.conversation/v2",
    authority: "external",
    conversation_id: randomUUID(),
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "c".repeat(64),
  };
  const event = randomUUID();
  const envelope = (revision: number, fact?: object) => ({
    ...request,
    event_id: fact ? randomUUID() : event,
    message_id: "answer",
    sequence: fact ? 1 : 0,
    revision,
    ...(fact ? { fact } : {}),
  });
  await legacyRow(f, workspace.id, 1, "plain old message", null);
  await legacyRow(f, workspace.id, 2, "Draft", envelope(1));
  await legacyRow(f, workspace.id, 3, "Draft answer", envelope(2));
  await legacyRow(f, workspace.id, 4, "", envelope(1, { type: "turn_terminal", outcome: "completed" }));
  await legacyRow(f, workspace.id, 5, "second plain message", null);

  const progress: number[] = [];
  const result = await convertLegacyConversations(f.context, { onProgress: (done) => progress.push(done.messages) });
  expect(result).toEqual({ workspaces: 1, messages: 5, records: 3 });
  expect(progress).toEqual([5]);

  const identified = await f.store.getConversation(f.principal.id, request.conversation_id);
  if (!identified) throw new Error("identified conversation missing");
  const [turn] = await f.store.readConversationRecords(identified.id);
  expect(turn).toMatchObject({ recordKey: request.turn_id, status: "completed" });
  expect(turn?.document.messages.map((message) => message.content)).toEqual(["Draft answer", ""]);

  const legacy = (await f.store.listConversations(workspace.id)).find((row) => row.conversationId === null);
  expect(legacy).toMatchObject({ legacy: true, messageCount: 2 });
  const records = await f.store.readConversationRecords(legacy?.id ?? "");
  expect(records.map((record) => [record.status, record.recordKey])).toEqual([
    ["legacy", "legacy:1"],
    ["legacy", "legacy:5"],
  ]);
  // The workspace history keeps the order the earlier release wrote.
  expect((await f.store.readWorkspaceConversation(workspace.id, 0, 10)).map((row) => row.message.content)).toEqual([
    "plain old message",
    "Draft answer",
    "",
    "second plain message",
  ]);

  expect(await convertLegacyConversations(f.context)).toEqual({ workspaces: 0, messages: 0, records: 0 });
  expect(await f.query(`SELECT count(*)::int AS n FROM ${f.schema}.workspace_conversation_messages`)).toEqual([
    { n: 0 },
  ]);
});
