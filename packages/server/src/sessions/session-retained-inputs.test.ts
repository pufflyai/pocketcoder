import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionInputManifestId, managed } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { completedSessionInputFixture } from "./session-inputs-fixture.test";

const queue = { count: 3, bytes: 1048576 };

test("a later request reprojects only its session's earlier accepted files and keeps its replay identity", async () => {
  const f = await completedSessionInputFixture();
  try {
    const other = randomUUID();
    await f.store.managed.sessions.create(f.keyId, { sessionId: other, profile: f.profile.name, owner: "other-chat" });
    const otherFile = await f.stage("other chat's private input", "other.txt", other);
    await f.store.managed.requests.accept(
      f.keyId,
      other,
      { requestId: randomUUID(), message: "other session", attachments: [otherFile.inputId] },
      queue,
    );
    const staged = await f.stage("not accepted yet", "future.txt");
    const body = { requestId: randomUUID(), message: "reread original file", attachments: [] };
    const accepted = await f.store.managed.requests.accept(f.keyId, f.sessionId, body, queue);
    await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId: randomUUID(), message: "future request", attachments: [staged.inputId] },
      queue,
    );

    await f.store.managed.requests.prepare(new Date());

    const next = (await f.store.executions.pending())[0]!;
    expect(next.acceptance.inputs.objects.map((file) => file.fileId)).toEqual([f.inputId]);
    expect(next.requestInputIds).toEqual([]);
    expect(accepted.request.inputFingerprint).toBe(managed.fingerprintRequest(body));
    expect((await f.store.managed.requests.accept(f.keyId, f.sessionId, body, queue)).replayed).toBe(true);
    await f.store.managed.requests.prepare(new Date());
    expect(await f.store.executions.get(next.acceptance.execution)).toEqual(next);
    const projection = await f.inputs.freeze(executionInputManifestId(next.acceptance), f.id, f.runtime.incarnationId, [
      f.inputId,
    ]);
    const object = projection.objects[0]!;
    expect(await new Response(await f.driver.read(object.backing, object.reference)).text()).toBe(f.content);
  } finally {
    await f.dispose();
  }
});

test("accepted files outlive staging expiry but close keeps only in-flight pins until finalization", async () => {
  const f = await completedSessionInputFixture();
  try {
    const unused = await f.stage("never accepted", "unused.txt");
    await f.context.db.update(f.context.tables.inputObjects).set({ retainedUntil: new Date(Date.now() - 1) });

    await f.inputs.reconcile();

    expect((await f.store.managed.files.get(f.keyId, f.sessionId, f.inputId)).state).toBe("ready");
    expect((await f.store.managed.files.get(f.keyId, f.sessionId, unused.inputId)).state).toBe("expired");
    await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId: randomUUID(), message: "reread without new upload", attachments: [] },
      queue,
    );
    await f.store.managed.requests.prepare(new Date());
    const next = (await f.store.executions.pending())[0]!;
    await f.store.executions.claim(next.acceptance.execution, new Date());
    await f.store.executions.beforeSend(next.acceptance.execution, new Date());
    await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId: randomUUID(), message: "explicitly reuse file", attachments: [f.inputId] },
      queue,
    );
    await f.store.managed.sessions.close(f.keyId, f.sessionId, new Date());
    await f.inputs.reconcile();
    expect((await f.store.inputs.get(f.upload.reference.workspaceId, f.inputId))?.state).toBe("ready");
    await f.finish(next);
    await f.inputs.reconcile(new Date(Date.now() + f.limits.retentionMs + 1));
    expect((await f.store.inputs.get(f.upload.reference.workspaceId, f.inputId))?.state).toBe("expired");
  } finally {
    await f.dispose();
  }
});

test("a follow-up after workspace replacement reprojects its session’s accepted bytes", async () => {
  const f = await completedSessionInputFixture();
  try {
    const { id, incarnationId } = await f.replaceWorkspace();
    const body = { requestId: randomUUID(), message: "reread file on replacement", attachments: [] };
    await f.store.managed.requests.accept(f.keyId, f.sessionId, body, queue);

    await f.store.managed.requests.prepare(new Date());

    const next = (await f.store.executions.pending())[0]!;
    expect(next.acceptance.execution.workspaceId).toBe(id);
    expect(next.acceptance.inputs.objects.map((file) => file.fileId)).toEqual([f.inputId]);
    const projection = await f.inputs.freeze(executionInputManifestId(next.acceptance), id, incarnationId, [f.inputId]);
    const object = projection.objects[0]!;
    expect(await new Response(await f.driver.read(object.backing, object.reference)).text()).toBe(f.content);
    expect(object.reference.storageOwnerId).toBe(f.upload.reference.workspaceId);
  } finally {
    await f.dispose();
  }
});

test("deleting history does not alter an accepted in-flight manifest and releases its bytes after finalization", async () => {
  const f = await completedSessionInputFixture();
  try {
    await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId: randomUUID(), message: "accepted reread", attachments: [] },
      queue,
    );
    await f.store.managed.requests.prepare(new Date());
    const next = (await f.store.executions.pending())[0]!;
    expect(await f.store.deleteConversationById(f.principal.id, f.sessionId, new Date())).toBe(true);
    await f.context.db.update(f.context.tables.inputObjects).set({ retainedUntil: new Date(Date.now() - 1) });
    await f.inputs.reconcile();
    expect((await f.store.inputs.get(f.upload.reference.workspaceId, f.inputId))?.state).toBe("ready");

    expect(await f.store.executions.claim(next.acceptance.execution, new Date())).not.toBeNull();

    await f.store.executions.beforeSend(next.acceptance.execution, new Date());
    await f.finish(next);
    await f.inputs.reconcile(new Date(Date.now() + f.limits.retentionMs + 1));
    expect((await f.store.inputs.get(f.upload.reference.workspaceId, f.inputId))?.state).toBe("expired");
  } finally {
    await f.dispose();
  }
});
