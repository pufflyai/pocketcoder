import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

async function readyPreview() {
  const server = await createTestServer(await createStore());
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  if (!found) throw new Error("missing key");
  await server.store.updatePrincipal(
    found.principal.id,
    [...found.principal.scopes, "previews:open"],
    found.principal.templateNames,
  );
  const template = await server.store.getTemplate("fixture-echo");
  if (!template) throw new Error("missing template");
  await server.store.upsertTemplate({
    ...template,
    version: "2.0.0",
    digest: `sha256:${"b".repeat(64)}`,
    spec: { ...template.spec, previews: { web: { port: 3000 } } } as typeof template.spec,
  });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: createTestBody(),
    }),
  );
  const { id } = (await created.json()) as { id: string };
  await server.scheduler.tick();
  await server.store.transition(id, { from: ["provisioning"], to: "connected", at: new Date() });
  await server.store.transition(id, { from: ["connected"], to: "ready", at: new Date() });
  return { server, id, principal: found.principal };
}

test("a preview token is one-time, bound to its host and checked against live key authority", async () => {
  const { server, id, principal } = await readyPreview();
  const minted = await server.app.request(
    `/v1/workspaces/${id}/previews/web`,
    authed(server.token, { method: "POST" }),
  );
  expect(minted.status).toBe(201);
  const { url } = (await minted.json()) as { url: string };
  expect(new URL(url).hostname).toBe(`${id.replaceAll("-", "")}-web.localhost`);
  const foreign = new URL(url);
  foreign.hostname = foreign.hostname.replace("-web", "-other");
  expect((await server.app.request(foreign)).status).toBe(401);
  const exchanged = await server.app.request(url);
  expect(exchanged.status).toBe(303);
  expect(exchanged.headers.get("location")).toBe("/");
  const cookie = exchanged.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
  expect((await server.app.request(url)).status).toBe(401);
  await server.store.updatePrincipal(principal.id, principal.scopes, principal.templateNames);
  expect(
    (await server.app.request(new URL("/", url), { headers: { cookie: cookie?.split(";")[0] ?? "" } })).status,
  ).toBe(401);
  await server.store.updatePrincipal(principal.id, [...principal.scopes, "previews:open"], principal.templateNames);
  await server.store.revokeMachineKey(server.keyId, new Date());
  const denied = await server.app.request(new URL("/", url), { headers: { cookie: cookie?.split(";")[0] ?? "" } });
  expect(denied.status).toBe(401);
});

test("preview mint denies foreign ownership and undeclared ports", async () => {
  const { server, id } = await readyPreview();
  const other = await server.store.createPrincipal("foreign", ["previews:open"], ["*"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await server.store.insertMachineKey({
    id: key.id,
    secretDigest: key.secretDigest,
    principalId: other.id,
    scopes: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  expect(
    (await server.app.request(`/v1/workspaces/${id}/previews/web`, authed(key.token, { method: "POST" }))).status,
  ).toBe(404);
  for (const name of ["other", "display", "pc-api", "3284"])
    expect(
      (await server.app.request(`/v1/workspaces/${id}/previews/${name}`, authed(server.token, { method: "POST" })))
        .status,
    ).toBe(400);
});

test("preview sessions cannot outlive the issuing key", async () => {
  const { server, id, principal } = await readyPreview();
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  const expiresAt = new Date(Date.now() + 500);
  await server.store.insertMachineKey({
    id: key.id,
    secretDigest: key.secretDigest,
    principalId: principal.id,
    scopes: [],
    createdAt: new Date(),
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const minted = await server.app.request(`/v1/workspaces/${id}/previews/web`, authed(key.token, { method: "POST" }));
  const { url, expires_at } = (await minted.json()) as { url: string; expires_at: string };
  expect(expires_at).toBe(expiresAt.toISOString());
  const exchanged = await server.app.request(url);
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(exchanged.status).toBe(303);
  await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now() + 1));
  expect((await server.app.request(new URL("/", url), { headers: { cookie } })).status).toBe(401);
});

test("malformed session JSON is a client validation error", async () => {
  const server = await createTestServer(await createStore());
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  if (!found) throw new Error("Missing fixture key");
  await server.store.updatePrincipal(
    found.principal.id,
    [...found.principal.scopes, "previews:open", "display:view"],
    ["*"],
  );
  for (const path of ["previews/web", "display"]) {
    const response = await server.app.request(
      `/v1/workspaces/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/${path}`,
      authed(server.token, { method: "POST", body: "{" }),
    );
    expect(response.status).toBe(400);
  }
});
