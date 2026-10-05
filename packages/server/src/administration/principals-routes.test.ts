import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { PrincipalResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

async function ownerServer() {
  const app = await createTestServer(await createStore());
  const owner = await app.store.createPrincipal("owner", ["admin"], ["*"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: owner.id,
    secretDigest: key.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const request = (path: string, init: RequestInit = {}) => app.app.request(path, authed(key.token, init));
  return { ...app, owner, request, expiresAt, ownerToken: key.token };
}

test("an explicit owner key creates and lists principals through HTTP", async () => {
  const app = await ownerServer();
  const response = await app.request("/v1/principals", {
    method: "POST",
    body: JSON.stringify({ name: "customer", scopes: ["workspaces:read"], templates: ["fixture-echo"] }),
  });
  expect(response.status).toBe(201);
  const principal = (await response.json()) as { id: string; name: string };
  expect(principal).toMatchObject({ name: "customer", scopes: ["workspaces:read"], templates: ["fixture-echo"] });
  expect(await app.store.getPrincipal(principal.id)).toMatchObject({ name: "customer" });
  const listed = await app.request("/v1/principals");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ items: expect.arrayContaining([principal]) });
});

test("a restricted key on an owner cannot create admin authority", async () => {
  const app = await ownerServer();
  const restricted = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: restricted.id,
    principalId: app.owner.id,
    secretDigest: restricted.secretDigest,
    scopes: ["principals:admin", "workspaces:read"],
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const response = await app.app.request(
    "/v1/principals",
    authed(restricted.token, {
      method: "POST",
      body: JSON.stringify({ name: "escalated", scopes: ["admin"], templates: ["*"] }),
    }),
  );
  expect(response.status).toBe(403);
  expect(await app.store.getPrincipalByName("escalated")).toBeNull();
});

test("a constrained administrator cannot list stronger principals", async () => {
  const app = await ownerServer();
  const caller = await app.store.createPrincipal(
    "constrained",
    ["principals:admin", "workspaces:read"],
    ["fixture-echo"],
  );
  const customer = await app.store.createPrincipal("visible-customer", ["workspaces:read"], ["fixture-echo"]);
  await app.store.createPrincipal("stronger-template", ["workspaces:read"], ["*"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: caller.id,
    secretDigest: key.secretDigest,
    scopes: caller.scopes,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const response = await app.app.request("/v1/principals", authed(key.token));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<{ id: string }> };
  expect(body.items.map((row) => row.id).sort()).toEqual([caller.id, customer.id].sort());
});

test("principal detail keeps identity immutable and name conflicts return 409", async () => {
  const app = await ownerServer();
  const customer = await app.store.createPrincipal("customer", ["workspaces:read"], ["fixture-echo"]);
  const detail = await app.request(`/v1/principals/${customer.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ id: customer.id, name: customer.name });
  const conflict = await app.request("/v1/principals", {
    method: "POST",
    body: JSON.stringify({ name: customer.name, scopes: [], templates: [] }),
  });
  expect(conflict.status).toBe(409);
  const identity = await app.request(`/v1/principals/${customer.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "replacement", scopes: [], templates: [] }),
  });
  expect(identity.status).toBe(400);
  expect(await app.store.getPrincipal(customer.id)).toMatchObject({ name: "customer" });
});

test("even an owner key cannot edit its own principal", async () => {
  const app = await ownerServer();
  const response = await app.request(`/v1/principals/${app.owner.id}`, {
    method: "PATCH",
    body: JSON.stringify({ scopes: [], templates: [], disabled: true }),
  });
  expect(response.status).toBe(403);
  expect(await app.store.getPrincipal(app.owner.id)).toMatchObject({ scopes: ["admin"], disabledAt: null });
});

async function constrainedRequest(app: Awaited<ReturnType<typeof ownerServer>>) {
  const caller = await app.store.createPrincipal(
    "limited-admin",
    ["principals:admin", "workspaces:read"],
    ["fixture-echo"],
  );
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: caller.id,
    secretDigest: key.secretDigest,
    scopes: caller.scopes,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  return { caller, request: (path: string, init: RequestInit = {}) => app.app.request(path, authed(key.token, init)) };
}

test("constrained updates check existing and requested grants and hide stronger details", async () => {
  const app = await ownerServer();
  const limited = await constrainedRequest(app);
  const customer = await app.store.createPrincipal("customer", ["workspaces:read"], ["fixture-echo"]);
  expect((await limited.request(`/v1/principals/${app.owner.id}`)).status).toBe(404);
  for (const [id, body] of [
    [app.owner.id, { scopes: [], templates: [] }],
    [customer.id, { scopes: ["workspaces:create"] }],
    [customer.id, { templates: ["*"] }],
    [limited.caller.id, { disabled: true }],
  ] as const) {
    expect(
      (await limited.request(`/v1/principals/${id}`, { method: "PATCH", body: JSON.stringify(body) })).status,
    ).toBe(403);
  }
  expect(await app.store.getPrincipal(customer.id)).toMatchObject({
    scopes: ["workspaces:read"],
    templateNames: ["fixture-echo"],
  });
  const updated = await limited.request(`/v1/principals/${customer.id}`, {
    method: "PATCH",
    body: JSON.stringify({ scopes: [], templates: [] }),
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ id: customer.id, name: "customer", scopes: [], templates: [] });
});

test("disabling a principal revokes its keys before returning and re-enable does not revive them", async () => {
  const app = await ownerServer();
  const customer = await app.store.createPrincipal("customer", ["workspaces:read"], ["fixture-echo"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: customer.id,
    secretDigest: key.secretDigest,
    scopes: customer.scopes,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const path = `/v1/principals/${customer.id}`;
  const disabled = await app.request(path, { method: "PATCH", body: JSON.stringify({ disabled: true }) });
  expect(disabled.status).toBe(200);
  expect(PrincipalResourceSchema.parse(await disabled.json()).disabled_at).toBeString();
  expect((await app.store.getMachineKeyWithPrincipal(key.id))?.key.revokedAt).toBeInstanceOf(Date);
  expect((await app.app.request("/v1/workspaces", authed(key.token))).status).toBe(401);
  expect((await app.request(path, { method: "PATCH", body: JSON.stringify({ disabled: false }) })).status).toBe(200);
  expect((await app.app.request("/v1/workspaces", authed(key.token))).status).toBe(401);
});

test("the SDK creates, reads, updates and disables principals through the real server", async () => {
  const app = await ownerServer();
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: listener.url.origin, apiKey: app.ownerToken });
    const customer = await client.principals.create({
      name: "sdk-customer",
      scopes: ["workspaces:read"],
      templates: ["fixture-echo"],
    });
    expect(await client.principals.get(customer.id)).toEqual(customer);
    expect((await client.principals.list()).items).toContainEqual(customer);
    expect(await client.principals.update(customer.id, { scopes: [], templates: [] })).toMatchObject({
      id: customer.id,
      scopes: [],
      templates: [],
    });
    expect((await client.principals.update(customer.id, { disabled: true })).disabled_at).toBeString();
    expect((await client.principals.update(customer.id, { disabled: false })).disabled_at).toBeNull();
  } finally {
    await listener.stop(true);
  }
});

test("principal writes reject oversized JSON before parsing it", async () => {
  const app = await ownerServer();
  const response = await app.request("/v1/principals", {
    method: "POST",
    body: `${" ".repeat(16_384)}${JSON.stringify({ name: "oversized", scopes: [], templates: [] })}`,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "validation.invalid" } });
  expect(await app.store.getPrincipalByName("oversized")).toBeNull();
});
