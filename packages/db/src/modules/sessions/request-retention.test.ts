import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { sessionWorkFixture } from "./work-fixture.test";

test("logical results survive physical purge and history deletion retains only a content-free request tombstone", async () => {
  const f = await sessionWorkFixture("disk", true);
  try {
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const input = {
      requestId: randomUUID(),
      message: "private prompt",
      attachments: [],
    };
    await f.store.managed.requests.accept(f.keyId, f.sessionId, input, { count: 2, bytes: 1048576 });
    await f.store.managed.requests.prepare(new Date());
    const record = (await f.store.executions.pending())[0]!;
    const bytes = Buffer.from("retained report");
    await f.store.executions.claim(record.acceptance.execution, new Date());
    const capacity = {
      workspace: { bytes: 4194304, files: 16 },
      principal: { bytes: 8388608, files: 32 },
      instance: { bytes: 16777216, files: 64 },
      freeDisk: { bytes: 33554432, files: 128, headroomBytes: 0, headroomFiles: 0 },
    };
    await f.store.exports.publish(
      record.acceptance.execution,
      record.acceptance.fingerprint,
      [
        {
          publicationId: randomUUID(),
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: bytes.length,
          digest: `sha256:${sha256Hex(bytes)}`,
          bytes,
        },
      ],
      true,
      new Date(),
      capacity,
    );
    await f.store.executions.observe(
      record.acceptance.execution,
      record.acceptance.fingerprint,
      "terminal",
      1,
      new Date(),
      { status: "completed", finalResponse: "private response" },
    );
    await f.store.exports.seal(record.acceptance.execution, new Date());
    await f.store.executions.acknowledge(record.acceptance.execution, record.acceptance.fingerprint, new Date());
    await f.store.executions.finalize(record.acceptance.execution, new Date());
    const before = await f.store.managed.requests.get(f.keyId, f.sessionId, input.requestId);
    const object = before.collection.objects[0]!;
    const at = new Date();
    await f.store.transition(f.id, { from: ["ready"], to: "terminating", at });
    await f.store.transition(f.id, { from: ["terminating"], to: "canceled", at });
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: at })
      .where(eq(f.context.tables.workspaces.id, f.id));
    await f.store.purgeWorkspaceContent(f.id, at);
    expect(Buffer.from(await f.store.managed.files.content(f.keyId, f.sessionId, object.exportId)).toString()).toBe(
      "retained report",
    );
    expect((await f.store.managed.files.exports(f.keyId, f.sessionId, input.requestId))[0]).toMatchObject({
      availability: "published",
    });
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, input.requestId)).collection).toEqual(
      before.collection,
    );
    // The terminal request committed its canonical record, which outlives the workspace purge.
    expect((await f.store.managed.history.history(f.keyId, f.sessionId, null, 10)).records).toHaveLength(1);
    expect(await f.store.deleteConversationById(f.principal.id, f.sessionId, at)).toBe(true);
    expect((await f.store.managed.history.history(f.keyId, f.sessionId, null, 10)).records).toEqual([]);
    await expect(f.store.managed.history.events(f.keyId, f.sessionId, `${f.sessionId}:0`, 10)).rejects.toMatchObject({
      code: "events.cursor_expired",
    });
    const [row] = await f.context.db
      .select()
      .from(f.context.tables.conversationRequests)
      .where(eq(f.context.tables.conversationRequests.requestId, input.requestId));
    expect(row?.managed?.input).toBeNull();
    expect(row?.execution).toBeNull();
    expect(row?.managed?.request.finalResponse).toBeNull();
    expect(row?.managed?.physicalExecution).toEqual(record.acceptance.execution);
    expect(
      (await f.store.managed.requests.accept(f.keyId, f.sessionId, input, { count: 2, bytes: 1048576 })).replayed,
    ).toBe(true);
    expect(Buffer.from(await f.store.managed.files.content(f.keyId, f.sessionId, object.exportId)).toString()).toBe(
      "retained report",
    );
  } finally {
    await f.dispose();
  }
});
