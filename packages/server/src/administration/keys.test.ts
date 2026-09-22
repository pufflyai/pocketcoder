import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";

async function fixture() {
  const store = new MemoryStore();
  const target = await store.createPrincipal("tenant", ["workspaces:read", "workspaces:purge"], []);
  const other = await store.createPrincipal("other", ["workspaces:read"], []);
  const operator = await store.createPrincipal("operator", ["admin"], []);
  const key = issueMachineKey("test-pepper");
  await store.insertMachineKey({
    id: key.id,
    secretDigest: key.secretDigest,
    principalId: operator.id,
    scopes: ["keys:read", "keys:write", "workspaces:recover"],
    managedPrincipalIds: [target.id],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const { app } = buildServer({
    store,
    driver: new FakeDriver(),
    pepper: "test-pepper",
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json", ...init.headers },
    });
  const body = {
    request_id: "issue-1",
    scopes: ["workspaces:read"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const issue = (value = body) =>
    request(`/v1/principals/${target.id}/keys`, { method: "POST", body: JSON.stringify(value) });
  return { store, app, target, other, request, issue, body, token: key.token };
}

test("lost issuance responses reconcile one key without replaying its secret", async () => {
  const f = await fixture();
  const first = await f.issue();
  expect(first.status).toBe(201);
  const issued = (await first.json()) as { key: { id: string }; token: string };
  expect(issued.token).toStartWith("pkt_");
  const replay = await f.issue();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ key: { id: issued.key.id }, token: null });
  const inventory = await f.request(`/v1/principals/${f.target.id}/keys?request_id=issue-1`);
  expect(inventory.status).toBe(200);
  const text = await inventory.text();
  expect(JSON.parse(text).items).toHaveLength(1);
  expect(text).not.toContain("secret");
  expect(text).not.toContain("digest");
  expect(text).not.toContain("pkt_");
  expect((await f.issue({ ...f.body, scopes: ["workspaces:purge"] })).status).toBe(409);
});

test("delegated key administration denies other principals and cannot issue administrative authority", async () => {
  const f = await fixture();
  for (const id of [f.other.id, crypto.randomUUID()])
    expect((await f.request(`/v1/principals/${id}/keys`)).status).toBe(404);
  expect((await f.issue({ ...f.body, scopes: ["admin"] })).status).toBe(403);
  expect((await f.issue({ ...f.body, scopes: ["keys:write"] })).status).toBe(403);
});

test("revoke-all closes issuance and leaves separately delegated recovery authority usable", async () => {
  const f = await fixture();
  const responses = await Promise.all([
    f.issue(),
    f.request(`/v1/principals/${f.target.id}/keys`, { method: "DELETE" }),
  ]);
  expect(responses[1]?.status).toBe(200);
  expect((await f.issue({ ...f.body, request_id: "after-revocation" })).status).toBe(403);
  const response = await f.request(`/v1/principals/${f.target.id}/keys`);
  expect(response.status).toBe(200);
  const listed = (await response.json()) as { items: { revoked_at: string | null }[] };
  expect(listed.items.every((key) => key.revoked_at !== null)).toBe(true);
  expect((await f.request(`/v1/principals/${f.target.id}/keys`, { method: "DELETE" })).status).toBe(200);
});

test("public issuance requires a future expiry and explicit bounded scopes", async () => {
  const f = await fixture();
  expect((await f.issue({ ...f.body, expires_at: new Date(0).toISOString() })).status).toBe(400);
  expect((await f.issue({ ...f.body, scopes: [] })).status).toBe(400);
});

test("SDK inventory, reconciliation and revocation use the real public server", async () => {
  const f = await fixture();
  const server = Bun.serve({ port: 0, fetch: f.app.fetch });
  const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: f.token });
  try {
    const issued = await client.keys.issue(f.target.id, { ...f.body, scopes: ["workspaces:read"] });
    expect(issued.token).toStartWith("pkt_");
    const replay = await client.keys.issue(f.target.id, { ...f.body, scopes: ["workspaces:read"] });
    expect(replay.token).toBeNull();
    expect(replay.key.id).toBe(issued.key.id);
    const keys = [];
    for await (const key of client.keys.all(f.target.id, { limit: 1 })) keys.push(key);
    expect(keys.map((key) => key.id)).toEqual([issued.key.id]);
    await client.keys.revoke(f.target.id, issued.key.id);
    await client.keys.revoke(f.target.id, issued.key.id);
    expect((await client.keys.list(f.target.id, { requestId: f.body.request_id })).items[0]?.revoked_at).not.toBeNull();
    await client.keys.revokeAll(f.target.id);
    await expect(
      client.keys.issue(f.target.id, { ...f.body, scopes: ["workspaces:read"], request_id: "new" }),
    ).rejects.toMatchObject({ code: "auth.disabled_principal" });
  } finally {
    server.stop(true);
  }
});
