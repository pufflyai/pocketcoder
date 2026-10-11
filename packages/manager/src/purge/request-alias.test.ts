import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createManagerApp } from "../app";
import { managerContext } from "../database/context";
import { ManagerStore } from "../database/store";
import { createRequestDigest, intentKeys, type PurgeIntent, purgeRequestDigest } from "./intent";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "authority arrival fences a new UUID created from an earlier empty manager snapshot",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-request-alias-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let context: Awaited<ReturnType<typeof managerContext>> | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observe!: (body: Uint8Array) => void;
    const observed = new Promise<Uint8Array>((resolve) => {
      observe = resolve;
    });
    let armed = false;
    let creating: Promise<Response> | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const source = join(root, "source");
      const stale = join(root, "stale");
      const authority = join(root, "authority");
      const expiry = new Date(Date.now() + 60_000);
      const config = {
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
      };
      store = await ManagerStore.create(source);
      const token = await store.createOperator(expiry);
      await store.close();
      store = undefined;
      await cp(source, stale, { recursive: true });
      const requestId = "original private create request";
      store = await ManagerStore.create(source);
      const original = await store.createAccount(requestId, { name: "private label" }, () => config, expiry);
      await store.close();
      store = undefined;
      const owned = fixture;
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const key = decodeURIComponent(url.pathname.slice(`/${owned.config.bucket}/`.length));
          try {
            const condition = request.headers.get("if-none-match");
            const response = await owned.storage.request(
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
              observe(bytes);
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
      const purgeConfig = { directory: authority, storage: { ...fixture.config, endpoint: proxy.url.toString() } };
      store = await ManagerStore.create(stale, purgeConfig);
      const app = createManagerApp(store, config);
      armed = true;
      creating = Promise.resolve(
        app.request("/v1/accounts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": requestId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "private label" }),
        }),
      );
      const empty = await Promise.race([
        observed,
        Bun.sleep(1000).then(() => {
          throw new Error("Admission listing was not observed");
        }),
      ]);
      expect(Buffer.from(empty).toString()).not.toContain("<Version>");
      const intent: PurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId: original.account.id,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(requestId),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      // This is real external authority arrival, not a concurrent second manager writer.
      for (const key of intentKeys(intent)) {
        const receipt = await fixture.storage.putIfAbsent(key, Buffer.from(JSON.stringify(intent)));
        expect(await (await fixture.storage.get(key, receipt.versionId)).json()).toEqual(intent);
      }
      release();
      const response = await creating;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "account_purged" });
      await store.close();
      store = undefined;
      context = await managerContext(stale);
      const [alias] = await context.db.select({ id: context.tables.accounts.id }).from(context.tables.accounts);
      const [operation] = await context.db.select({ id: context.tables.operations.id }).from(context.tables.operations);
      if (!alias || !operation) throw new Error("Actual stale-created account/operation missing");
      expect(alias.id).not.toBe(original.account.id);
      await context.close();
      context = undefined;
      store = await ManagerStore.create(stale, purgeConfig);
      console.log(
        JSON.stringify({
          staleCreateAlias: {
            originalId: original.account.id,
            aliasId: alias.id,
            response: response.status,
            listed: (await store.listAccounts()).map((row) => row.id),
            pending: (await store.pendingOperations()).map((row) => row.id),
          },
        }),
      );
      expect(await store.listAccounts()).toEqual([]);
      expect(await store.pendingOperations()).toEqual([]);
      await expect(store.getAccount(alias.id)).rejects.toThrow("account_purged");
      await expect(store.finishAccount(alias.id, operation.id)).rejects.toThrow("account_purged");
    } catch (error) {
      failure = error;
    } finally {
      release();
      await creating?.catch(() => {});
      for (const result of await Promise.allSettled([
        store?.close(),
        context?.close(),
        proxy?.stop(true),
        fixture?.close(),
      ]))
        if (result.status === "rejected") errors.push(result.reason);
      for (const result of await Promise.allSettled([rm(root, { recursive: true, force: true })]))
        if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...errors], "Request alias cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
