import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffNodeBackupReceiptSchema } from "./backup-receipt";
import { readPrivateFile, writePrivateJson } from "./private-files";

test("schema-valid receipt inventory cannot publish a private file its bounded reader cannot reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc93-metadata-limit-"));
  try {
    const accountId = randomUUID();
    const writer = {
      format: "pocketcoder-source-writer/v1",
      directory: "/private/pc_data",
      root: { device: "1", inode: "1" },
      lock: { device: "1", inode: "2" },
    };
    // This exercises the accepted schema/file boundary, not a 300-runtime managed deployment.
    const runtimes = Array.from({ length: 300 }, () => {
      const id = randomUUID();
      return {
        kind: "workspace",
        id,
        provider: "kubernetes",
        ref: {
          kind: "kubernetes",
          id: `pocketcoder-ws-${id}`,
          namespace: `pc-account-${accountId}`,
          jobUid: randomUUID(),
        },
      };
    });
    const receipt = OffNodeBackupReceiptSchema.parse({
      accountId,
      operationId: randomUUID(),
      snapshotId: randomUUID(),
      createdAt: new Date().toISOString(),
      plaintextDigest: `sha256:${"a".repeat(64)}`,
      journal: { journalId: randomUUID(), sequence: 1, digest: "b".repeat(64) },
      sourceWriter: writer,
      runtimes,
      staging: {
        reservationId: randomUUID(),
        archiveBytes: 1,
        contents: { bytes: 1, files: 1, directories: 1 },
        database: { bytes: 1, files: 1, directories: 1 },
      },
      object: {
        key: "accounts/backup.enc",
        versionId: "version",
        etag: "etag",
        bytes: 42,
        digest: `sha256:${"c".repeat(64)}`,
      },
    });
    const marker = { operationId: randomUUID(), snapshotId: receipt.snapshotId, sourceWriter: writer, receipt };
    for (const [name, value] of [
      ["receipt.json", receipt],
      ["off-node-restore.json", marker],
    ] as const) {
      const path = join(directory, name);
      expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(65_536);
      await expect(writePrivateJson(path, value, 65_536)).rejects.toThrow("private file limit");
      expect(await readdir(directory)).toEqual([]);
      const small =
        name === "receipt.json" ? { ...receipt, runtimes: [] } : { ...marker, receipt: { ...receipt, runtimes: [] } };
      await writePrivateJson(path, small, 65_536);
      expect(JSON.parse((await readPrivateFile(path, 65_536)).toString())).toEqual(small);
      await expect(writePrivateJson(path, value, 65_536)).rejects.toThrow("private file limit");
      expect(JSON.parse((await readPrivateFile(path, 65_536)).toString())).toEqual(small);
      await rm(path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
