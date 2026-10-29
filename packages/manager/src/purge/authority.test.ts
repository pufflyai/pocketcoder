import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createPurgeAuthority, type PurgeAuthority } from "./authority";
import { createRequestDigest, intentKeys, type PurgeIntent, purgeRequestDigest } from "./intent";

const enabled = process.env.PC94_S3_TEST === "1";

test.skipIf(!enabled)(
  "failed remote acknowledgement retains a permanent private intent through restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-purge-outage-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let authority: PurgeAuthority | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      let rejectWrites = false;
      const storage = fixture.storage;
      const bucket = fixture.config.bucket;
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (rejectWrites && request.method === "PUT") return new Response("Unavailable", { status: 503 });
          const url = new URL(request.url);
          const key = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length));
          try {
            // The forwarding signer binds the real endpoint Host; the fault only rejects writes.
            return await storage.request(
              request.method,
              key,
              Object.fromEntries(url.searchParams),
              request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            );
          } catch (error) {
            if (error instanceof Error && "status" in error && typeof error.status === "number")
              return new Response(null, { status: error.status });
            throw error;
          }
        },
      });
      const config = {
        directory: join(root, "authority"),
        storage: { ...fixture.config, endpoint: proxy.url.toString() },
      };
      authority = await createPurgeAuthority(join(root, "manager"), config);
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId: randomUUID(),
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest("never retain this text"),
        purgeRequestDigest: purgeRequestDigest("purge never retain this text"),
        admittedAt: new Date().toISOString(),
      };
      rejectWrites = true;
      await expect(authority.acknowledge(intent)).rejects.toThrow("503");
      expect(() => authority?.assertAccount(intent.accountId)).toThrow("account_purged");
      expect(() => authority?.assertRequest("never retain this text")).toThrow("account_purged");
      authority.close();
      authority = undefined;
      await expect(createPurgeAuthority(join(root, "manager"), config)).rejects.toThrow("503");
      rejectWrites = false;
      authority = await createPurgeAuthority(join(root, "manager"), config);
      for (const key of intentKeys(intent)) expect(await (await storage.get(key)).json()).toEqual(intent);
      expect(() => authority?.assertAccount(intent.accountId)).toThrow("account_purged");
    } catch (error) {
      failure = error;
    } finally {
      authority?.close();
      const cleaned = await Promise.allSettled([proxy?.stop(true), fixture?.close()]);
      cleaned.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleaned) if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupFailures],
        "Purge outage fixture cleanup failed",
      );
    if (failure) throw failure;
  },
  30_000,
);

test("purge authority refuses a physical folder inside manager data through a parent alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc94-purge-path-"));
  try {
    await symlink(root, join(root, "alias"));
    await expect(
      createPurgeAuthority(root, {
        directory: join(root, "alias", "purge"),
        storage: {
          endpoint: "http://127.0.0.1:1",
          bucket: "unused",
          region: "unused",
          accessKeyId: "unused",
          secretAccessKey: "unused",
        },
      }),
    ).rejects.toThrow("outside the data folder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
