import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { eq } from "drizzle-orm";
import { inputFixture } from "./input-fixture.test";

// This uses a real stream delay and durable bytes; no storage or database adapter is replaced.
test("unreferenced retention starts at publication and suspended expiry permits another pin", async () => {
  const f = await inputFixture();
  try {
    f.limits.retentionMs = 100;
    const reference = f.reference();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await delay(150);
        controller.enqueue(Buffer.from("original"));
        controller.close();
      },
    });
    await f.service.upload(f.principal.id, reference, f.workspace.deadlineAt, body, new AbortController().signal);
    const stored = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    expect(stored.retainedUntil.getTime() - stored.publishedAt!.getTime()).toBeGreaterThanOrEqual(100);
    const firstId = randomUUID();
    await f.store.inputs.freeze(firstId, f.workspace.id, "runtime", [reference.fileId], stored.publishedAt!);
    const secondId = randomUUID();
    await f.store.inputs.freeze(
      secondId,
      f.workspace.id,
      "runtime",
      [reference.fileId],
      new Date(stored.retainedUntil.getTime() + 1),
    );
    await f.service.reconcile(new Date(stored.retainedUntil.getTime() + 1));
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.state).toBe("ready");
    await f.service.finalize(firstId);
    await f.service.reconcile(new Date(Date.now() + 1000));
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.state).toBe("ready");
    await f.service.finalize(secondId);
    const finalized = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    await f.service.reconcile(new Date(finalized.retainedUntil.getTime() + 1));
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.state).toBe("expired");
  } finally {
    await f.dispose();
  }
});

test("stale cleanup cannot release a retried file ID", async () => {
  const f = await inputFixture();
  try {
    const reference = f.reference();
    await expect(f.upload("bad", reference)).rejects.toThrow();
    const old = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    await f.upload("original", reference);
    expect(
      await f.store.inputs.beginRelease(
        f.workspace.id,
        reference.fileId,
        old.reservationId,
        new Date(Date.now() + 1_000_000),
      ),
    ).toBe(false);
    await expect(f.store.inputs.release(f.workspace.id, reference.fileId, old.reservationId)).rejects.toThrow();
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.state).toBe("ready");
  } finally {
    await f.dispose();
  }
});

test("private roots reject dot-prefix descendants and physical mount aliases", async () => {
  const f = await inputFixture();
  try {
    const workloads = join(f.root, "workloads");
    await mkdir(workloads);
    expect(() => new FilesystemInputStorage(join(workloads, "..private"), [workloads])).toThrow("overlap");
    expect(() => new FilesystemInputStorage(f.root, [join(f.root, "..workload")])).toThrow("overlap");
    const alias = join(f.root, "alias");
    await symlink(workloads, alias);
    expect(() => new FilesystemInputStorage(join(alias, "private"), [workloads])).toThrow("overlap");
  } finally {
    await f.dispose();
  }
});

test("expiry and orphan recovery remove empty directory entries", async () => {
  const f = await inputFixture();
  try {
    await f.upload();
    await f.service.reconcile(new Date(Date.now() + 700_000));
    expect(await readdir(f.root)).toEqual([]);
    const orphanWorkspace = randomUUID();
    await mkdir(join(f.root, orphanWorkspace, randomUUID()), { recursive: true });
    await f.service.reconcile();
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("workspace purge waits for pins and removes canonical bytes before metadata", async () => {
  const f = await inputFixture();
  try {
    const { reference } = await f.upload();
    const manifestId = randomUUID();
    await f.service.freeze(manifestId, f.workspace.id, "runtime", [reference.fileId]);
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(f.context.tables.workspaces.id, f.workspace.id));
    await expect(f.service.purge(f.workspace.id)).rejects.toThrow("pending");
    await expect(f.store.purgeWorkspaceContent(f.workspace.id, new Date())).rejects.toThrow("pending");
    await f.service.finalize(manifestId);
    await f.service.purge(f.workspace.id);
    await f.store.purgeWorkspaceContent(f.workspace.id, new Date());
    expect(await readdir(f.root)).toEqual([]);
    expect(await f.store.inputs.getManifest(manifestId)).toBeNull();
    expect(await f.store.inputs.get(f.workspace.id, reference.fileId)).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("empty-parent pruning cannot interrupt concurrent directory publication", async () => {
  const f = await inputFixture();
  try {
    for (let i = 0; i < 20; i++) {
      const ref = { workspaceId: f.workspace.id, fileId: randomUUID(), versionId: randomUUID() };
      await mkdir(join(f.root, ref.workspaceId, ref.fileId), { recursive: true });
      const [, writer] = await Promise.all([f.driver.pruneEmpty([]), f.driver.create(ref)]);
      await writer.write(Buffer.from("original"));
      await writer.publish();
      await f.driver.remove(ref);
    }
    await f.driver.pruneEmpty([]);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("finalization during real byte verification prevents a projection reference", async () => {
  const f = await inputFixture();
  try {
    const body = "x".repeat(1024 * 1024);
    const { reference } = await f.upload(body);
    const id = randomUUID();
    const freezing = f.service.freeze(id, f.workspace.id, "runtime", [reference.fileId]);
    const result = freezing.then(
      () => "projected",
      () => "finalized",
    );
    await f.service.finalize(id);
    expect(await result).toBe("finalized");
  } finally {
    await f.dispose();
  }
});
