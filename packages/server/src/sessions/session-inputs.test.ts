import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionInputManifestId, sha256Hex } from "@pstdio/pocketcoder-contracts";
import { sessionWorkFixture } from "@pstdio/pocketcoder-db/testing";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { eq } from "drizzle-orm";
import { InputStorage } from "../attachments/input-storage";

test("accepted session inputs remain pinned through expiry and reproject the same bytes after physical purge", async () => {
  const f = await sessionWorkFixture("disk");
  const root = await mkdtemp(join(tmpdir(), "pc-logical-inputs-"));
  const driver = new FilesystemInputStorage(root, []);
  const limits = {
    fileBytes: 1048576,
    stagedBytes: 8388608,
    files: 16,
    transfers: 2,
    transferMs: 1000,
    retentionMs: 600000,
  };
  const inputs = new InputStorage(f.store.inputs, {
    driver,
    limits,
    capacity: async () => ({
      workspace: { bytes: 8388608, files: 16 },
      principal: { bytes: 16777216, files: 32 },
      instance: { bytes: 33554432, files: 64 },
      freeDisk: { bytes: 67108864, files: 128, headroomBytes: 0, headroomFiles: 0 },
    }),
  });
  try {
    const content = "canonical test input";
    const inputId = randomUUID();
    const registered = await f.store.managed.files.register(
      f.keyId,
      f.sessionId,
      {
        inputId,
        name: "tests.txt",
        mediaType: "text/plain",
        sizeBytes: Buffer.byteLength(content),
        sha256: `sha256:${sha256Hex(Buffer.from(content))}`,
      },
      limits,
    );
    const upload = await f.store.managed.files.upload(f.keyId, f.sessionId, inputId);
    await inputs.upload(
      f.principal.id,
      upload.reference,
      upload.expiresAt,
      new Response(content).body,
      new AbortController().signal,
      f.sessionId,
    );
    const body = {
      requestId: randomUUID(),
      message: "test",
      attachments: [registered.reference],
      dispatchDeadline: new Date(Date.now() + 60000).toISOString(),
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
    ).rejects.toThrow("expired");
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
    await f.store.endWorkspaceRuntime(f.id, f.runtime.incarnationId, new Date());
    await f.store.transition(f.id, { from: ["ready"], to: "terminating", at: new Date() });
    await f.store.transition(f.id, { from: ["terminating"], to: "canceled", at: new Date() });
    await f.store.managed.capacity.cleanup(f.id, 0, "provider_fenced", new Date());
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(f.context.tables.workspaces.id, f.id));
    await inputs.purge(f.id);
    await f.store.purgeWorkspaceContent(f.id, new Date());
    await f.store.managed.requests.completeCleanup(f.id);
    expect((await f.store.managed.files.get(f.keyId, f.sessionId, inputId)).reference).toEqual(registered.reference);
    const original = await f.store.getWorkspace(f.id);
    if (!original) throw Error("Missing original workspace");
    const id = randomUUID(),
      incarnationId = randomUUID();
    await f.store.insertWorkspace({
      id,
      principalId: f.principal.id,
      externalId: id,
      idempotencyKey: id,
      requestDigest: id,
      templateId: original.templateId,
      templateSnapshot: original.templateSnapshot,
      launchInput: null,
      metadata: {},
      deadlineAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
    });
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        state: "ready",
        connectionEpoch: 1,
        runtimeRegistration: {
          ...f.runtime,
          incarnationId,
          containerIdentity: incarnationId,
          readyAt: new Date().toISOString(),
          producer: { ...f.runtime.producer, workspaceId: id, incarnationId },
        },
      })
      .where(eq(f.context.tables.workspaces.id, id));
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 1, {
      workspaceId: id,
      incarnationId,
      generation: 2,
    });
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
    await rm(root, { recursive: true, force: true });
  }
});
