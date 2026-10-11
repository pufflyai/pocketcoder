import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createPurgeAuthority, type PurgeAuthority } from "./authority";
import { createRequestDigest, intentKeys, type PurgeIntent, PurgeIntentSchema, purgeRequestDigest } from "./intent";

type Storage = Awaited<ReturnType<typeof objectStorageFixture>>["storage"];
const enabled = process.env.PC94_S3_TEST === "1";

async function openUpload(storage: Storage, key: string, bytes: number) {
  const uploadId = await storage.beginMultipart(key);
  const part = await storage.request("PUT", key, { uploadId, partNumber: "1" }, Buffer.alloc(bytes, 0x62));
  expect(part.headers.get("etag")).toBeTruthy();
  await part.body?.cancel();
  const parts = await (await storage.request("GET", key, { uploadId })).text();
  expect(parts).toContain("<PartNumber>1</PartNumber>");
  expect(parts).toContain(`<Size>${bytes}</Size>`);
  return { key, uploadId };
}

test.skipIf(!enabled)(
  "real account object cleanup removes versions, delete markers and uploaded parts while purge indexes survive",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-account-objects-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let authority: PurgeAuthority | undefined;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const { storage } = fixture;
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      const prefix = `accounts/${accountId}/`;
      const otherPrefix = `accounts/${otherAccountId}/`;
      const requestId = randomUUID();
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(requestId),
        purgeRequestDigest: purgeRequestDigest("purge account"),
        admittedAt: new Date().toISOString(),
      };
      const authorityConfig = { directory: join(root, "purge-authority"), storage: fixture.config };
      authority = await createPurgeAuthority(join(root, "manager"), authorityConfig);
      await authority.acknowledge(intent);
      const indexes = await storage.versions("manager/purge/");
      expect(indexes.map((item) => item.key).sort()).toEqual(intentKeys(intent).sort());
      expect(indexes.every((item) => !item.deleted && item.latest)).toBe(true);

      const archiveKey = `${prefix}backups/${randomUUID()}/archive.enc`;
      const first = await storage.put(archiveKey, Buffer.from("older archive fixture"));
      const second = await storage.put(archiveKey, Buffer.from("newer archive fixture"));
      expect(first.versionId).not.toBe(second.versionId);
      const marker = await storage.request("DELETE", archiveKey);
      const markerVersion = marker.headers.get("x-amz-version-id");
      if (!markerVersion) throw new Error("Real delete marker version is missing");
      await marker.body?.cancel();
      await expect(storage.get(archiveKey)).rejects.toMatchObject({ status: 404 });
      expect(await (await storage.get(first.key, first.versionId)).text()).toBe("older archive fixture");
      await storage.put(`${prefix}journal/head.json`, Buffer.from("first journal fixture"));
      await storage.put(`${prefix}journal/head.json`, Buffer.from("second journal fixture"));
      const upload = await openUpload(storage, `${prefix}backups/${randomUUID()}/partial.enc`, 6 * 1024 ** 2);

      const retainedKey = `${otherPrefix}backups/retained.enc`;
      const retainedFirst = await storage.put(retainedKey, Buffer.from("other account older bytes"));
      const retainedSecond = await storage.put(retainedKey, Buffer.from("other account latest bytes"));
      const retainedUpload = await openUpload(storage, `${otherPrefix}backups/partial.enc`, 32 * 1024);
      const otherVersions = await storage.versions(otherPrefix);
      const otherUploads = await storage.multipart(otherPrefix);
      expect(otherVersions).toHaveLength(2);
      expect(otherUploads).toEqual([retainedUpload]);
      const versions = await storage.versions(prefix);
      expect(versions).toHaveLength(5);
      expect(versions.filter((item) => item.deleted)).toEqual([
        { key: archiveKey, versionId: markerVersion, deleted: true, latest: true },
      ]);
      expect(await storage.multipart(prefix)).toEqual([upload]);
      console.log(
        JSON.stringify({
          realObjectCleanupBefore: {
            fixture: fixture.config.bucket,
            accountId,
            otherAccountId,
            versions: versions.length,
            deleteMarkers: 1,
            openUploads: 1,
            uploadedPartBytes: 6 * 1024 ** 2,
            retainedVersions: otherVersions.length,
            retainedUploads: otherUploads.length,
            purgeIndexes: indexes.length,
          },
        }),
      );

      await storage.clean(prefix);
      expect(await storage.versions(prefix)).toEqual([]);
      expect(await storage.multipart(prefix)).toEqual([]);
      for (const version of versions)
        await expect(storage.get(version.key, version.versionId)).rejects.toMatchObject({ status: 404 });
      await expect(storage.request("GET", upload.key, { uploadId: upload.uploadId })).rejects.toMatchObject({
        status: 404,
      });
      expect(await storage.versions(otherPrefix)).toEqual(otherVersions);
      expect(await storage.multipart(otherPrefix)).toEqual(otherUploads);
      expect(await (await storage.get(retainedFirst.key, retainedFirst.versionId)).text()).toBe(
        "other account older bytes",
      );
      expect(await (await storage.get(retainedSecond.key, retainedSecond.versionId)).text()).toBe(
        "other account latest bytes",
      );
      const retainedParts = await (
        await storage.request("GET", retainedUpload.key, { uploadId: retainedUpload.uploadId })
      ).text();
      expect(retainedParts).toContain("<Size>32768</Size>");
      expect(await storage.versions("manager/purge/")).toEqual(indexes);
      for (const index of indexes) {
        expect(PurgeIntentSchema.parse(await (await storage.get(index.key, index.versionId)).json())).toEqual(intent);
        expect(PurgeIntentSchema.parse(await (await storage.get(index.key)).json())).toEqual(intent);
      }

      // Purge retries must not erase the independent account and request fences.
      await storage.clean(prefix);
      authority.close();
      authority = undefined;
      authority = await createPurgeAuthority(join(root, "manager"), authorityConfig);
      expect(authority.account(accountId)).toEqual(intent);
      expect(() => authority?.assertAccount(accountId)).toThrow("account_purged");
      expect(() => authority?.assertRequest(requestId)).toThrow("account_purged");
      expect(await storage.versions("manager/purge/")).toEqual(indexes);
      expect(await storage.versions(otherPrefix)).toEqual(otherVersions);
      expect(await storage.multipart(otherPrefix)).toEqual(otherUploads);
      console.log(
        JSON.stringify({
          realObjectCleanupAfter: {
            accountId,
            versions: 0,
            deleteMarkers: 0,
            openUploads: 0,
            retainedVersions: otherVersions.length,
            retainedUploads: otherUploads.length,
            unchangedPurgeIndexes: indexes.length,
            reopenedAccountFence: true,
            reopenedRequestFence: true,
          },
        }),
      );
    } catch (error) {
      failure = error;
    } finally {
      const cleaned = await Promise.allSettled([Promise.resolve().then(() => authority?.close()), fixture?.close()]);
      cleaned.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleaned) if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupFailures],
        "Owned object cleanup fixture cleanup failed",
      );
    if (failure) throw failure;
  },
  30_000,
);
