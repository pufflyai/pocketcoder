import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { sessionInputFixture } from "./session-inputs-fixture.test";

test("accepted session inputs remain pinned through expiry and reproject the same bytes after physical purge", async () => {
  const f = await sessionInputFixture("disk");
  const { inputs, inputId, content, registered, upload, driver } = f;
  try {
    const body = {
      requestId: randomUUID(),
      message: "test",
      attachments: [registered.reference.inputId],
    };
    await f.store.managed.requests.accept(f.keyId, f.sessionId, body, { count: 2, bytes: 1048576 });
    await f.context.db
      .update(f.context.tables.inputObjects)
      .set({ retainedUntil: new Date(Date.now() - 1) })
      .where(eq(f.context.tables.inputObjects.fileId, inputId));
    await inputs.reconcile();
    await expect(
      f.store.managed.requests.accept(
        f.keyId,
        f.sessionId,
        { ...body, requestId: randomUUID() },
        { count: 2, bytes: 1048576 },
      ),
    ).resolves.toMatchObject({ replayed: false });
    expect(
      (await f.store.managed.requests.accept(f.keyId, f.sessionId, body, { count: 2, bytes: 1048576 })).replayed,
    ).toBe(true);
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    await f.store.managed.requests.prepare(new Date());
    const record = (await f.store.executions.pending())[0]!;
    const projection = await inputs.freeze(executionInputManifestId(record.acceptance), f.id, f.runtime.incarnationId, [
      inputId,
    ]);
    expect(projection.objects[0]?.backing.workspaceId).toBe(upload.reference.workspaceId);
    expect(projection.objects[0]?.reference.workspaceId).toBe(f.id);
    const { id, incarnationId } = await f.replaceWorkspace();
    const replay = await f.store.managed.requests.accept(f.keyId, f.sessionId, body, { count: 2, bytes: 1048576 });
    expect(replay.replayed).toBe(true);
    await f.store.managed.requests.prepare(new Date());
    const next = (await f.store.executions.pending())[0]!;
    expect(next.conversationIdentity?.turn_id).toBe(record.conversationIdentity?.turn_id);
    const logical = await f.store.managed.requests.get(f.keyId, f.sessionId, body.requestId);
    expect(logical.inputFingerprint).toBe(replay.request.inputFingerprint);
    const restored = await inputs.freeze(executionInputManifestId(next.acceptance), id, incarnationId, [inputId]);
    const object = restored.objects[0]!;
    expect(await new Response(await driver.read(object.backing, object.reference)).text()).toBe(content);
    const canonical = projection.objects[0];
    if (!canonical) throw Error("Missing canonical projection");
    expect(object.backing).toEqual(canonical.backing);
  } finally {
    await f.dispose();
  }
});
