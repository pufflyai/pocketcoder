import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { eq } from "drizzle-orm";
import { managerContext } from "../database/context";
import { managerRepositories } from "../database/store";
import { createPurgeAuthority } from "./authority";
import { guardedStore } from "./guarded-store";
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
  "purge waits for a store-direct bootstrap lookup already queued behind a real transaction",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-admitted-lookup-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let context: Awaited<ReturnType<typeof managerContext>> | undefined;
    let authority: Awaited<ReturnType<typeof createPurgeAuthority>> | undefined;
    let transaction: Promise<unknown> | undefined;
    let completing: Promise<unknown> | undefined;
    let settling: Promise<unknown> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observe!: () => void;
    const observed = new Promise<void>((resolve) => {
      observe = resolve;
    });
    let failure: unknown;
    const failures: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const directory = join(root, "data");
      context = await managerContext(directory);
      authority = await createPurgeAuthority(directory, {
        directory: join(root, "authority"),
        storage: fixture.config,
      });
      const raw = managerRepositories(context);
      const store = guardedStore(raw, authority);
      const expiry = new Date(Date.now() + 60_000);
      const requestId = randomUUID();
      const created = await store.createAccount(
        requestId,
        { name: "private label" },
        () => ({
          controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
          runtimeClassName: "pc-runc",
        }),
        expiry,
      );
      await store.finishAccount(created.account.id, created.operation.id);
      const bootstrap = await store.beginBootstrap(
        created.account.id,
        {
          request_id: randomUUID(),
          expires_at: expiry.toISOString(),
        },
        expiry,
      );
      // The real engine queues subsequent queries until this existing transaction releases it.
      const { accounts } = context.tables;
      transaction = context.db.transaction(async (tx) => {
        await tx.select().from(accounts).where(eq(accounts.id, created.account.id));
        observe();
        await gate;
      });
      await within(observed, "Real transaction did not enter");
      completing = store.completeBootstrap(bootstrap.id, randomUUID());
      const outcome = completing.then(
        () => null,
        (error: unknown) => error,
      );
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId: created.account.id,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(requestId),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      await authority.acknowledge(intent);
      let settled = false;
      settling = store.settlePurge(intent).then(() => {
        settled = true;
      });
      expect(
        await (await fixture.storage.get(`manager/purge/accounts/${intent.accountId}/intent.json`)).json(),
      ).toEqual(intent);
      expect(settled).toBe(false);
      release();
      await transaction;
      expect(await outcome).toMatchObject({ message: "account_purged" });
      await within(settling, "Queued lookup did not settle");
      expect(settled).toBe(true);
      const [row] = await context.db
        .select()
        .from(context.tables.bootstrapRequests)
        .where(eq(context.tables.bootstrapRequests.id, bootstrap.id));
      expect(row?.state).toBe("pending");
      expect(row?.keyId).toBeNull();
    } catch (error) {
      failure = error;
    } finally {
      release();
      await Promise.allSettled([transaction, completing, settling]);
      authority?.close();
      const results = await Promise.allSettled([context?.close(), fixture?.close()]);
      results.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      failures.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    }
    if (failures.length)
      throw new AggregateError([...(failure ? [failure] : []), ...failures], "Admitted lookup cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
