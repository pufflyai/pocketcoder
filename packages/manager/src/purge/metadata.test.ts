import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createPurgeAuthority } from "./authority";
import { createRequestDigest, intentKeys, type PurgeIntent, purgeRequestDigest } from "./intent";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "oversized remote intent is refused before a held body tail arrives",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-purge-metadata-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failure: unknown;
    let opening: ReturnType<typeof createPurgeAuthority> | undefined;
    const errors: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId: randomUUID(),
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest("metadata"),
        purgeRequestDigest: purgeRequestDigest("purge metadata"),
        admittedAt: new Date().toISOString(),
      };
      const key = intentKeys(intent)[0] as string;
      await fixture.storage.put(key, Buffer.from(`${JSON.stringify(intent)}${" ".repeat(1024 ** 2)}`));
      const storage = fixture.storage;
      const bucket = fixture.config.bucket;
      let tailDelivered = false;
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const requested = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length));
          let response: Response;
          try {
            response = await storage.request(
              request.method,
              requested,
              Object.fromEntries(url.searchParams),
              request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            );
          } catch (error) {
            if (error instanceof ObjectStorageError) return new Response(null, { status: error.status });
            throw error;
          }
          if (requested !== key) return response;
          const bytes = await response.bytes();
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(bytes.subarray(0, 65_537));
                await tail;
                tailDelivered = true;
                try {
                  controller.enqueue(bytes.subarray(65_537));
                  controller.close();
                } catch {}
              },
            }),
          );
        },
      });
      opening = createPurgeAuthority(join(root, "manager"), {
        directory: join(root, "authority"),
        storage: { ...fixture.config, endpoint: proxy.url.toString() },
      });
      const observed = opening.then(
        () => "opened",
        (error: Error) => error.message,
      );
      expect(await Promise.race([observed, Bun.sleep(1000).then(() => "still waiting for oversized body")])).toBe(
        "Purge tombstone exceeds its metadata limit.",
      );
      expect(tailDelivered).toBe(false);
    } catch (error) {
      failure = error;
    } finally {
      release();
      await opening?.then(
        (authority) => authority.close(),
        () => {},
      );
      const cleanup = await Promise.allSettled([proxy?.stop(true), fixture?.close()]);
      cleanup.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleanup) if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...errors], "Metadata fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
