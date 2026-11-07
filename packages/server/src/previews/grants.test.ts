import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";
import { PreviewGrants } from "./grants";

const createStore = createTestStoreFactory();
test("cloud opens require durable per-user grants, enforce revisions and reject revoked cookies", async () => {
  const server = await createTestServer(await createStore(), {}, undefined, {
    publicViews: {
      apiOrigin: "https://api.example.org",
      origin: "https://views.example.net",
      parents: [],
      trustedIngress: [],
    },
  });
  const owner = await server.store.getMachineKeyWithPrincipal(server.keyId);
  const template = await server.store.getTemplate("fixture-echo");
  if (!owner || !template) throw new Error("missing fixture");
  await server.store.updatePrincipal(owner.principal.id, [...owner.principal.scopes, "previews:open"], ["*"]);
  await server.store.upsertTemplate({
    ...template,
    version: "2.0.0",
    digest: `sha256:${"f".repeat(64)}`,
    spec: { ...template.spec, previews: { web: { port: 3000 } } },
  });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, { method: "POST", headers: { "idempotency-key": randomUUID() }, body: createTestBody() }),
  );
  const { id } = (await created.json()) as { id: string };
  await server.scheduler.tick();
  await server.store.transition(id, { from: ["provisioning"], to: "connected", at: new Date() });
  await server.store.transition(id, { from: ["connected"], to: "ready", at: new Date() });
  const base = `https://api.example.org/v1/workspaces/${id}`;
  const post = (path: string, body: object) =>
    server.app.request(base + path, authed(server.token, { method: "POST", body: JSON.stringify(body) }));
  expect((await post("/previews/web", { session: { mode: "top_level" } })).status).toBe(400);
  const grantId = randomUUID();
  const input = {
    id: grantId,
    subject: "U",
    accessRevision: "r1",
    previews: ["web"],
    ceilingAt: new Date(Date.now() + 60000).toISOString(),
  };
  const grant = await post("/preview-grants", input);
  expect(grant.status).toBe(201);
  expect((await post("/preview-grants", { ...input, accessRevision: "r2" })).status).toBe(409);
  const workspace = await server.store.getWorkspace(id);
  if (!workspace) throw new Error("Missing workspace");
  const grants = new PreviewGrants(server.store);
  await expect(grants.get({ ...workspace, id: randomUUID() }, server.keyId, grantId)).rejects.toThrow();
  await expect(
    grants.get({ ...workspace, providerRef: { kind: "fixture", id: "replacement" } }, server.keyId, grantId),
  ).rejects.toThrow();
  const minted = await post("/previews/web", { grantId, session: { mode: "top_level" } });
  expect(minted.status).toBe(201);
  const { url } = (await minted.json()) as { url: string };
  expect((await post(`/preview-grants/${grantId}/renew`, { accessRevision: "r1" })).status).toBe(200);
  const exchanged = await server.app.request(url);
  expect(exchanged.status).toBe(303);
  expect((await server.app.request(url)).status).toBe(401);
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0] ?? "";
  const check = new URL("/.pc/check", url);
  expect((await server.app.request(check, { headers: { cookie } })).status).toBe(204);
  expect((await post(`/preview-grants/${grantId}/renew`, { accessRevision: "r2" })).status).toBe(401);
  expect((await post(`/preview-grants/${grantId}/revoke`, {})).status).toBe(200);
  expect((await server.app.request(check, { headers: { cookie } })).status).toBe(401);
  expect((await post(`/preview-grants/${grantId}/renew`, { accessRevision: "r1" })).status).toBe(401);
});
