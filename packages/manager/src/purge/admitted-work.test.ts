import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { ManagerStore } from "../database/store";
import { createRequestDigest, type PurgeIntent, purgeRequestDigest } from "./intent";

async function within<T>(work: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "purge settles an admitted create while later unrelated work stays live",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-admitted-work-"));
    const fixture = await objectStorageFixture().catch(async (error) => {
      await rm(root, { recursive: true, force: true });
      throw error;
    });
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let creating: Promise<unknown> | undefined;
    let unrelated: Promise<unknown> | undefined;
    let failure: unknown;
    const failures: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseUnrelated!: () => void;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    let observe!: () => void;
    const observed = new Promise<void>((resolve) => {
      observe = resolve;
    });
    let entered!: () => void;
    const unrelatedEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let armed = false;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.slice(`/${fixture.config.bucket}/`.length));
        try {
          const condition = request.headers.get("if-none-match");
          const response = await fixture.storage.request(
            request.method,
            key,
            Object.fromEntries(url.searchParams),
            request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            condition ? { "if-none-match": condition } : {},
          );
          if (
            armed &&
            request.method === "GET" &&
            url.searchParams.has("versions") &&
            url.searchParams.get("prefix") === "manager/purge/accounts/"
          ) {
            armed = false;
            const bytes = await response.bytes();
            expect(Buffer.from(bytes).toString()).not.toContain("<Version>");
            observe();
            await gate;
            return new Response(bytes, { status: response.status, headers: response.headers });
          }
          return response;
        } catch (error) {
          if (error instanceof ObjectStorageError) return new Response(null, { status: error.status });
          throw error;
        }
      },
    });
    try {
      store = await ManagerStore.create(join(root, "data"), {
        directory: join(root, "authority"),
        storage: { ...fixture.config, endpoint: proxy.url.toString() },
      });
      const expiresAt = new Date(Date.now() + 60_000);
      const config = {
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
      };
      const other = await store.createAccount(randomUUID(), { name: "other" }, () => config, expiresAt);
      const requestId = randomUUID();
      armed = true;
      creating = store.createAccount(requestId, { name: "target" }, () => config, expiresAt);
      const createOutcome = creating.then(
        () => null,
        (error: unknown) => error,
      );
      await within(observed, "Actual admission listing was not observed");
      // This absent UUID models rollback to an earlier empty database, not provider identity proof.
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId: randomUUID(),
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(requestId),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      await store.purge?.acknowledge(intent);
      let settled = false;
      const settling = store.settlePurge(intent).then(() => {
        settled = true;
      });
      // A completed real remote read observes the fence while the earlier admission is still held.
      expect(
        await (await fixture.storage.get(`manager/purge/accounts/${intent.accountId}/intent.json`)).json(),
      ).toEqual(intent);
      expect(settled).toBe(false);
      unrelated = store.runAccountWork(other.account.id, async () => {
        entered();
        await unrelatedGate;
      });
      release();
      expect(await createOutcome).toBeInstanceOf(Error);
      await within(unrelatedEntered, "Later unrelated work did not enter");
      await within(settling, "Unrelated later work extended purge settlement");
      expect(settled).toBe(true);
      expect((await store.listAccounts()).map((row) => row.id)).toEqual([other.account.id]);
      releaseUnrelated();
      await unrelated;
    } catch (error) {
      failure = error;
    } finally {
      release();
      releaseUnrelated();
      await Promise.allSettled([creating, unrelated]);
      const results = await Promise.allSettled([store?.close(), proxy.stop(true), fixture.close()]);
      results.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      failures.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    }
    if (failures.length)
      throw new AggregateError([...(failure ? [failure] : []), ...failures], "Admitted work fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
