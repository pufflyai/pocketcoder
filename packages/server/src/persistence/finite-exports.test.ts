import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finiteOutputMounts } from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "@pstdio/pocketcoder-db/testing";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { finiteExports } from "./finite-exports";

test.each(["complete", "empty", "unsafe", "missing", "expired", "cancel", "lost", "capacity", "long"])(
  "finite collection records %s independently of workload outcome and is replayable after storage removal",
  async (mode) => {
    const f = await executionFixture();
    const root = await mkdtemp(join(tmpdir(), "pc131-finalize-"));
    try {
      const { acceptance, phase } = await settle(f, mode);
      const workspace = await f.store.getWorkspace(f.id);
      if (!workspace) throw new Error("Missing workspace");
      const storage = new FilesystemStorageDriver({
        workspaceRoot: join(root, "work"),
        checkpointRoot: join(root, "checkpoints"),
      });
      const mounts = finiteOutputMounts(f.runtime.template.manifest.spec);
      const id = randomUUID();
      const allocated = await storage.allocate({
        storageId: id,
        workspaceId: f.id,
        mounts,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
      });
      const at = new Date();
      await f.store.insertWorkspaceStorage({
        id,
        workspaceId: f.id,
        principalId: f.principal.id,
        providerKind: storage.kind,
        providerRef: allocated.ref,
        mountManifest: mounts,
        state: "ready",
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        retainedUntil: null,
        logicalBytes: null,
        fileCount: null,
        lastErrorCode: null,
      });
      if (mode !== "empty")
        await writeFile(join(String(allocated.ref.root), "finite-output-0", "result.txt"), "diagnostics");
      if (mode === "long") {
        const directory = join(String(allocated.ref.root), "finite-output-0", "a".repeat(220));
        await mkdir(directory);
        await writeFile(join(directory, "b".repeat(80)), "bounded");
      }
      if (mode === "unsafe")
        await symlink("/etc/passwd", join(String(allocated.ref.root), "finite-output-0", "escape"));
      if (mode === "missing") await rm(String(allocated.ref.root), { recursive: true });
      const clock = mode === "expired" ? new Date(Date.now() + 31000) : new Date();
      const capacity = {
        workspace: { bytes: mode === "capacity" ? 0 : 4194304, files: 16 },
        principal: { bytes: 8388608, files: 32 },
        instance: { bytes: 16777216, files: 64 },
        freeDisk: { bytes: 33554432, files: 128, headroomBytes: 0, headroomFiles: 0 },
      };
      const finalize = finiteExports({
        store: f.store,
        storageDriver: storage,
        now: () => clock,
        readCapacity: () => capacity,
      });
      await finalize(workspace);
      const result = await f.store.executions.get(acceptance.execution);
      const manifest = result?.collection;
      if (!manifest) throw new Error("Missing collection receipt");
      expect(result.phase).toBe(phase);
      expect(result.outcome).toEqual({ exitCode: 7 });
      if (["missing", "expired", "capacity"].includes(mode)) expect(manifest.completeness).toBe("lost");
      else expect(manifest.completeness).toBe(["unsafe", "lost", "long"].includes(mode) ? "partial" : "complete");
      if (mode === "empty") expect(manifest.objects).toEqual([]);
      await rm(String(allocated.ref.root), { recursive: true, force: true });
      await finalize(workspace);
      expect((await f.store.executions.get(acceptance.execution))?.collection).toEqual(manifest);
      const object = manifest.objects[0];
      if (object) {
        expect(
          Buffer.from((await f.store.exports.content(f.id, object.objectId, f.principal.id, clock)) ?? []).toString(),
        ).toBe("diagnostics");
        await f.store.exports.delete(acceptance.execution, manifest.exportId, f.principal.id, clock);
        expect(await f.store.exports.content(f.id, object.objectId, f.principal.id, clock)).toBeNull();
      }
    } finally {
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function settle(f: Awaited<ReturnType<typeof executionFixture>>, mode: string) {
  const acceptance = f.acceptance();
  await f.store.executions.accept(acceptance, new Date());
  await f.store.executions.claim(acceptance.execution, new Date());
  if (mode === "cancel")
    await f.store.executions.cancel(
      { execution: acceptance.execution, scope: "operation", cancelId: randomUUID() },
      new Date(),
    );
  const phases = { lost: "lost", cancel: "canceled" } as const;
  const phase = phases[mode as keyof typeof phases] ?? "terminal";
  await f.store.executions.observe(acceptance.execution, acceptance.fingerprint, phase, 1, new Date(), {
    exitCode: 7,
  });
  await f.store.executions.acknowledge(acceptance.execution, acceptance.fingerprint, new Date());
  await f.store.endWorkspaceRuntime(f.id, acceptance.execution.incarnationId, new Date());
  return { acceptance, phase };
}

test("purge teardown does not publish output after its deletion fence", async () => {
  const f = await executionFixture();
  try {
    const { acceptance } = await settle(f, "complete");
    const { eq } = await import("drizzle-orm");
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(f.context.tables.workspaces.id, f.id));
    const row = await f.store.getWorkspace(f.id);
    if (!row) throw new Error("Missing workspace");
    await expect(finiteExports({ store: f.store })(row)).resolves.toBeUndefined();
    expect((await f.store.executions.get(acceptance.execution))?.collection).toBeUndefined();
  } finally {
    await f.dispose();
  }
});
