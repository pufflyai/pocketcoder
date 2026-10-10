import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBackup } from "@pstdio/pocketcoder-db/backup";
import { createMaintenance } from "../maintenance/maintenance";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { createControllerBackup } from "./controller-backup";

// Each test opens two PGlite engines: the controller and the verifier's scratch copy.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const keys = {
  pepper: randomBytes(32).toString("base64url"),
  eventSigningKey: randomBytes(32).toString("base64url"),
  secretKey: randomBytes(32).toString("base64url"),
};

// A controller with one published checkpoint archive, ready to back up.
async function controller() {
  const f = await checkpointHttpFixture(new TextEncoder().encode("checkpoint bytes"));
  const out = await realpath(await mkdtemp(join(tmpdir(), "pc-backup-out-")));
  cleanup.push(f.dispose, () => rm(out, { recursive: true, force: true }));
  const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
  const grant = await f.grant;
  expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
  const checkpoint = await pending;
  const maintenance = createMaintenance();
  const backup = createControllerBackup({ store: f.store, maintenance, keys, checkpointDirectory: f.directory });
  const signal = new AbortController().signal;
  async function remove() {
    await f.store.updateCheckpoint(checkpoint.id, { state: "deleting" }, new Date());
    await f.service.delete(checkpoint);
  }
  return { f, out, maintenance, backup, signal, checkpoint, remove };
}

test("a backup captures the database, keys and the checkpoint archives it references", async () => {
  const { f, out, backup, signal, checkpoint } = await controller();
  const output = join(out, "controller.tar");
  const receipt = await backup({ output, timeout_ms: 5000 }, signal);
  expect(receipt).toMatchObject({ output, checkpoints: 1 });

  const { manifest } = await verifyBackup(output);
  expect(manifest.checkpoints).toEqual([
    expect.objectContaining({
      checkpointId: checkpoint.id,
      bytes: f.raw.length,
      digest: `sha256:${createHash("sha256").update(f.raw).digest("hex")}`,
    }),
  ]);
  expect(manifest.snapshotId).toBe(receipt.snapshot_id);
}, 30_000);

test("a deletion admitted before the window finishes before the snapshot and is not captured", async () => {
  const { out, maintenance, backup, signal, remove } = await controller();
  let finish!: () => void;
  const admitted = maintenance.admit(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await remove();
  });
  const output = join(out, "settled.tar");
  const pending = backup({ output, timeout_ms: 5000 }, signal);
  await Bun.sleep(20);
  // New writes wait for the window; reads keep working.
  expect(maintenance.active).toBe(true);
  await expect(maintenance.admit(async () => {})).rejects.toMatchObject({ code: "maintenance.active" });
  finish();
  await admitted;
  expect((await pending).checkpoints).toBe(0);
  expect((await verifyBackup(output)).manifest.checkpoints).toEqual([]);
  expect(maintenance.active).toBe(false);
}, 30_000);

test("a deletion after the snapshot cannot remove bytes the backup references", async () => {
  const { f, out, maintenance, signal, remove } = await controller();
  const output = join(out, "held.tar");
  await f.store.backup({
    output,
    checkpointDirectory: f.directory,
    keys: { "auth-pepper": randomBytes(32), "event-signing-key": randomBytes(32), "secret-key": randomBytes(32) },
    signal,
    freeze: async (capture) => {
      const snapshot = await maintenance.run(5000, signal, capture);
      await remove();
      return snapshot;
    },
  });
  expect(await readdir(f.directory)).toEqual([]);
  expect((await verifyBackup(output)).manifest.checkpoints).toHaveLength(1);
}, 30_000);

test("a window that cannot settle in time leaves no archive and resumes writes", async () => {
  const { out, maintenance, backup, signal } = await controller();
  let finish!: () => void;
  const stuck = maintenance.admit(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(backup({ output: join(out, "late.tar"), timeout_ms: 100 }, signal)).rejects.toMatchObject({
    code: "maintenance.timeout",
  });
  expect(await readdir(out)).toEqual([]);
  expect(maintenance.active).toBe(false);
  await maintenance.admit(async () => {});
  finish();
  await stuck;
}, 30_000);

test("a backup refuses checkpoints that live outside the controller instead of leaving them out", async () => {
  const { f, out, backup, signal } = await controller();
  await f.query(`UPDATE "${f.schema}"."workspace_checkpoints" SET provider_kind = 'kubernetes-pvc'`);
  await expect(backup({ output: join(out, "partial-set.tar"), timeout_ms: 5000 }, signal)).rejects.toThrow(
    "kubernetes-pvc",
  );
  expect(await readdir(out)).toEqual([]);
}, 30_000);

test("a controller whose keys came from the environment refuses a backup it could not restore", async () => {
  const { f, out, maintenance, signal } = await controller();
  const backup = createControllerBackup({ store: f.store, maintenance, checkpointDirectory: f.directory });
  await expect(backup({ output: join(out, "env.tar"), timeout_ms: 5000 }, signal)).rejects.toThrow("key bundle");
  expect(await readdir(out)).toEqual([]);
}, 30_000);
