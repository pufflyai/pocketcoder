import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagerStore } from "../database/store";
import { managerMonitoring } from "./metrics";

test("a delayed receipt cannot make an old recovery point look fresh", async () => {
  const store = await ManagerStore.create();
  const monitoring = managerMonitoring(store);
  try {
    const expiry = new Date(Date.now() + 60_000);
    const created = await store.createAccount(
      "backup-age",
      { name: "private-backup" },
      () => ({
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
        offNodeBackups: true,
      }),
      expiry,
    );
    await store.finishAccount(created.account.id, created.operation.id);
    for (const [index, age] of [3600, 7200].entries()) {
      const { operation } = await store.beginBackupOperation(created.account.id, "backup", `capture-${index}`, expiry);
      await store.saveBackup(operation.id, {
        accountId: created.account.id,
        operationId: operation.id,
        snapshotId: randomUUID(),
        createdAt: new Date(Date.now() - age * 1000).toISOString(),
        plaintextDigest: `sha256:${"a".repeat(64)}`,
        journal: { journalId: randomUUID(), sequence: 0, digest: "b".repeat(64) },
        sourceWriter: {
          format: "pocketcoder-source-writer/v1",
          directory: "/private/pc_data",
          root: { device: "1", inode: "1" },
          lock: { device: "1", inode: "2" },
        },
        runtimes: [],
        staging: {
          reservationId: randomUUID(),
          archiveBytes: 1,
          contents: { bytes: 1, files: 1, directories: 1 },
          database: { bytes: 1, files: 1, directories: 1 },
        },
        object: {
          key: "private-path",
          versionId: "private-version",
          etag: "etag",
          bytes: 42,
          digest: `sha256:${"c".repeat(64)}`,
        },
      });
    }
    const text = await monitoring.metrics();
    const line = text.split("\n").find((line) => line.startsWith("pocketcoder_account_backup_age_seconds{"));
    const age = Number(line?.split(" ").at(-1));
    expect(age).toBeGreaterThanOrEqual(3600);
    expect(age).toBeLessThan(3605);
    expect(text).not.toContain("private-path");
    expect(text).not.toContain("private-version");
  } finally {
    await monitoring.close();
    await store.close();
  }
}, 20_000);
