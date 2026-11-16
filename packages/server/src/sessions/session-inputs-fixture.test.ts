import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutionRecord, sha256Hex } from "@pstdio/pocketcoder-contracts";
import { sessionWorkFixture } from "@pstdio/pocketcoder-db/testing";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { eq } from "drizzle-orm";
import { InputStorage } from "../attachments/input-storage";

export async function sessionInputFixture(mode: "memory" | "disk" = "memory") {
  const f = await sessionWorkFixture(mode);
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
  async function stage(content: string, name = "tests.txt", sessionId = f.sessionId) {
    const inputId = randomUUID();
    const registered = await f.store.managed.files.register(
      f.keyId,
      sessionId,
      {
        inputId,
        name,
        mediaType: "text/plain",
        sizeBytes: Buffer.byteLength(content),
        sha256: `sha256:${sha256Hex(Buffer.from(content))}`,
      },
      limits,
    );
    const upload = await f.store.managed.files.upload(f.keyId, sessionId, inputId);
    await inputs.upload(
      f.principal.id,
      upload.reference,
      upload.expiresAt,
      new Response(content).body,
      new AbortController().signal,
      sessionId,
    );
    return { inputId, content, registered, upload };
  }
  return {
    ...f,
    ...(await stage("canonical test input")),
    inputs,
    driver,
    limits,
    stage,
    async replaceWorkspace() {
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
      return { id, incarnationId };
    },
    async finish(record: ExecutionRecord) {
      await f.store.executions.observe(
        record.acceptance.execution,
        record.acceptance.fingerprint,
        "terminal",
        1,
        new Date(),
        { status: "completed" },
      );
      await f.store.exports.seal(record.acceptance.execution, new Date());
      await f.store.executions.acknowledge(record.acceptance.execution, record.acceptance.fingerprint, new Date());
      await f.store.executions.finalize(record.acceptance.execution, new Date());
    },
    async dispose() {
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function completedSessionInputFixture() {
  const f = await sessionInputFixture();
  await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
    workspaceId: f.id,
    incarnationId: f.runtime.incarnationId,
    generation: 1,
  });
  await f.store.managed.requests.accept(
    f.keyId,
    f.sessionId,
    {
      requestId: randomUUID(),
      message: "read attached file",
      attachments: [f.inputId],
    },
    { count: 3, bytes: 1048576 },
  );
  await f.store.managed.requests.prepare(new Date());
  const firstRecord = (await f.store.executions.pending())[0];
  if (!firstRecord) throw new Error("Missing first execution");
  await f.store.executions.claim(firstRecord.acceptance.execution, new Date());
  await f.store.executions.beforeSend(firstRecord.acceptance.execution, new Date());
  await f.finish(firstRecord);
  return { ...f, firstRecord };
}
