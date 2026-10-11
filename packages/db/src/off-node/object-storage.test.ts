import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "./object-storage-fixture";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "real S3 retains exact versions and clears only failed operation objects and multipart uploads",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-s3-files-"));
    try {
      const retained = await fixture.storage.put("other-account/keep", Buffer.from("keep"));
      const bytes = randomBytes(9 * 1024 ** 2);
      const path = join(root, "backup.enc");
      await writeFile(path, bytes);
      const first = await fixture.storage.uploadFile("account-a/op-a/backup.enc", path);
      const second = await fixture.storage.put(first.key, Buffer.from("new version"));
      expect(second.versionId).not.toBe(first.versionId);
      expect(Buffer.from(await (await fixture.storage.get(first.key, first.versionId)).arrayBuffer())).toEqual(bytes);
      expect(await fixture.storage.versions("account-a/")).toHaveLength(2);
      const pendingKey = "account-a/op-a/unfinished";
      await fixture.storage.beginMultipart(pendingKey);
      expect(await fixture.storage.multipart("account-a/op-a/")).toHaveLength(1);
      await fixture.storage.clean("account-a/op-a/");
      expect(await fixture.storage.versions("account-a/op-a/")).toEqual([]);
      expect(await fixture.storage.multipart("account-a/op-a/")).toEqual([]);
      expect(await (await fixture.storage.get(retained.key, retained.versionId)).text()).toBe("keep");
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
