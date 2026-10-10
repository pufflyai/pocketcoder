import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("finite operator creates one durable account and operation across HTTP retry and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-manager-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let store = await ManagerStore.create(directory);
  cleanup.push(() => store.close());
  const token = await store.createOperator(new Date(Date.now() + 60_000));
  const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
  let app = createManagerApp(store, config);
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": "account-one",
    "content-type": "application/json",
  };
  expect((await app.request("/v1/accounts")).status).toBe(401);
  const first = await app.request("/v1/accounts", { method: "POST", headers, body: JSON.stringify({ name: "one" }) });
  expect(first.status).toBe(202);
  const response = z.object({
    account: z.object({ id: z.uuid(), state: z.string() }),
    operation: z.object({ id: z.uuid() }),
  });
  const created = response.parse(await first.json());
  expect(created.account.state).toBe("provisioning");
  expect(
    (await app.request("/v1/accounts", { method: "POST", headers, body: JSON.stringify({ name: "two" }) })).status,
  ).toBe(409);
  await store.close();
  store = await ManagerStore.create(directory);
  app = createManagerApp(store, config);
  const repeated = response.parse(
    await (
      await app.request("/v1/accounts", { method: "POST", headers, body: JSON.stringify({ name: "one" }) })
    ).json(),
  );
  expect(repeated.account.id).toBe(created.account.id);
  expect(repeated.operation.id).toBe(created.operation.id);
  expect(
    z.object({ items: z.array(z.unknown()) }).parse(await (await app.request("/v1/accounts", { headers })).json())
      .items,
  ).toHaveLength(1);
  expect(
    z
      .object({ id: z.uuid() })
      .parse(await (await app.request(`/v1/accounts/${created.account.id}`, { headers })).json()).id,
  ).toBe(created.account.id);
  expect(
    z
      .object({ state: z.string() })
      .parse(await (await app.request(`/v1/operations/${created.operation.id}`, { headers })).json()).state,
  ).toBe("pending");
  const expired = await store.createOperator(new Date(Date.now() + 10));
  await Bun.sleep(20);
  expect((await app.request("/v1/accounts", { headers: { authorization: `Bearer ${expired}` } })).status).toBe(401);
  await expect(store.createOperator(new Date(Date.now() + 25 * 3600_000))).rejects.toThrow("24 hours");
});

test("manager rejects oversized bodies before reading account input", async () => {
  const store = await ManagerStore.create();
  cleanup.push(() => store.close());
  const token = await store.createOperator(new Date(Date.now() + 60_000));
  const app = createManagerApp(store, {
    controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
    runtimeClassName: "pc-runc",
  });
  const response = await app.request("/v1/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "too-big" },
    body: "x".repeat(8193),
  });
  expect(response.status).toBe(413);
  expect(await store.listAccounts()).toEqual([]);
});

test("an operator that expires while sending a body cannot create an account", async () => {
  const store = await ManagerStore.create();
  cleanup.push(() => store.close());
  const app = createManagerApp(store, {
    controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
    runtimeClassName: "pc-runc",
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  cleanup.push(async () => {
    await server.stop(true);
  });
  const token = await store.createOperator(new Date(Date.now() + 500));
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const pending = fetch(new URL("/v1/accounts", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "delayed", "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }),
  });
  await Bun.sleep(650);
  body.enqueue(new TextEncoder().encode('"name":"after expiry"}'));
  body.close();
  expect((await pending).status).toBe(401);
  expect(await store.listAccounts()).toEqual([]);
  expect(await store.pendingOperations()).toEqual([]);
});
