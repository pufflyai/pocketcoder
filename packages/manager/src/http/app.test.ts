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

test("accounts report their public origins and reject parents on the view domain", async () => {
  const store = await ManagerStore.create();
  cleanup.push(() => store.close());
  const token = await store.createOperator(new Date(Date.now() + 60_000));
  const app = createManagerApp(store, {
    controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
    runtimeClassName: "pc-runc",
    publicHosts: {
      apiOrigin: "https://pocketcoder.datazine.app",
      viewOrigin: "https://embed.kaset.dev",
      issuer: "pocketcoder-dns",
      ingressClassName: "pocketcoder",
      ingressNamespace: "pocketcoder-edge",
      trustedIngress: ["10.244.0.0/16"],
    },
  });
  const create = (key: string, parents: string[]) =>
    app.request("/v1/accounts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "content-type": "application/json" },
      body: JSON.stringify({ name: key, parents }),
    });
  const rejected = await create("same-domain", ["https://app.kaset.dev"]);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ code: "invalid_public_hosts" });
  const created = z
    .object({ account: z.object({ id: z.uuid(), api_origin: z.string(), view_origin: z.string() }) })
    .parse(await (await create("embedded", ["https://app.example.org"])).json());
  const label = created.account.id.replaceAll("-", "");
  expect(created.account.api_origin).toBe(`https://${label}.pocketcoder.datazine.app`);
  expect(created.account.view_origin).toBe(`https://${label}.embed.kaset.dev`);
  expect(await store.listAccounts()).toHaveLength(1);
});

test("a replayed create returns its account after the public host settings change", async () => {
  const store = await ManagerStore.create();
  cleanup.push(() => store.close());
  const token = await store.createOperator(new Date(Date.now() + 60_000));
  const base = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
  const publicHosts = {
    apiOrigin: "https://pocketcoder.datazine.app",
    viewOrigin: "https://embed.kaset.dev",
    issuer: "pocketcoder-dns",
    ingressClassName: "pocketcoder",
    ingressNamespace: "pocketcoder-edge",
    trustedIngress: ["10.244.0.0/16"],
  };
  const create = (config: Parameters<typeof createManagerApp>[1]) =>
    createManagerApp(store, config).request("/v1/accounts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "replayed", "content-type": "application/json" },
      body: JSON.stringify({ name: "replayed", parents: ["https://app.example.org"] }),
    });
  const first = (await (await create({ ...base, publicHosts })).json()) as { account: { id: string } };
  const replay = await create(base);
  expect(replay.status).toBe(202);
  expect(((await replay.json()) as typeof first).account.id).toBe(first.account.id);
});
