import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { ManagerStore } from "../database/store";
import { ManagerReceiptSchema } from "../recovery/manifest";
import { managerBackupProbe } from "./backup-schedule";
import { managerMonitoring } from "./metrics";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pc103-backup-observation-"));
  const journalId = randomUUID();
  const receiptFile = "2026-10-13T00.receipt.json";
  const operationId = randomUUID();
  const createdAt = new Date(Date.now() - 7200_000).toISOString();
  const receipt = ManagerReceiptSchema.parse({
    format: "pocketcoder-manager-receipt/v1",
    operationId,
    createdAt,
    journal: { journalId, sequence: 0, digest: "a".repeat(64) },
    sourceWriter: {
      format: "pocketcoder-source-writer/v1",
      directory: "/private/manager",
      root: { device: "1", inode: "1" },
      lock: { device: "1", inode: "2" },
    },
    plaintext: { bytes: 1, digest: `sha256:${"b".repeat(64)}` },
    footprint: { bytes: 1, files: 1, directories: 1 },
    object: {
      key: "private-object",
      versionId: "private-version",
      etag: "etag",
      bytes: 1,
      digest: `sha256:${"c".repeat(64)}`,
    },
  });
  await writePrivateJson(join(directory, receiptFile), receipt);
  const health = { operationId, attemptedAt: new Date().toISOString(), result: "succeeded", receiptFile };
  await writePrivateJson(join(directory, "health.json"), health);
  return { directory, journalId, receiptFile, receipt, health, probe: managerBackupProbe(directory, journalId) };
}

test("manager backup age uses the snapshot point, even when receipt files are copied later", async () => {
  const f = await fixture();
  const store = await ManagerStore.create();
  const monitoring = managerMonitoring(store, { backup: f.probe });
  try {
    const later = new Date(Date.now() + 3600_000);
    await utimes(join(f.directory, f.receiptFile), later, later);
    await monitoring.sample();
    const text = await monitoring.metrics();
    const age = Number(
      text
        .split("\n")
        .find((line) => line.startsWith("pocketcoder_manager_backup_age_seconds "))
        ?.split(" ")
        .at(-1),
    );
    expect(age).toBeGreaterThanOrEqual(7200);
    expect(age).toBeLessThan(7205);
    expect(text).not.toContain(f.directory);
    expect(text).not.toContain(f.journalId);
    expect(text).not.toContain("private-object");
    expect(text).not.toContain("private-version");
    await writePrivateJson(join(f.directory, "health.json"), {
      ...f.health,
      result: "started",
      attemptedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
    });
    await monitoring.sample();
    const started = await monitoring.metrics();
    const elapsed = Number(
      started
        .split("\n")
        .find((line) => line.startsWith("pocketcoder_manager_backup_in_progress_seconds "))
        ?.split(" ")
        .at(-1),
    );
    expect(elapsed).toBeGreaterThan(1200);
    expect(started).toContain("pocketcoder_manager_backup_present 1");
  } finally {
    await monitoring.close();
    await store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 20_000);

test("another journal's receipt and a removed observation directory cannot report healthy backups", async () => {
  const f = await fixture();
  const store = await ManagerStore.create();
  const monitoring = managerMonitoring(store, { backup: f.probe });
  try {
    await writePrivateJson(join(f.directory, f.receiptFile), {
      ...f.receipt,
      journal: { ...f.receipt.journal, journalId: randomUUID() },
    });
    await monitoring.sample();
    expect(await monitoring.metrics()).toContain("pocketcoder_manager_backup_observed 0");
    await writePrivateJson(join(f.directory, f.receiptFile), f.receipt);
    await monitoring.sample();
    expect(await monitoring.metrics()).toContain("pocketcoder_manager_backup_observed 1");
    await rm(f.directory, { recursive: true, force: true });
    await monitoring.sample();
    const missing = await monitoring.metrics();
    expect(missing).toContain("pocketcoder_manager_backup_observed 0");
    expect(missing).toContain("pocketcoder_manager_backup_present NaN");
    expect(missing).toContain("pocketcoder_manager_pending_operations 0");
  } finally {
    await monitoring.close();
    await store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 20_000);
