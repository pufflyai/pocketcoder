import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

test("display sessions require current view and control grants and never serve workspace HTML", async () => {
  const server = await createTestServer(await createStore());
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  const template = await server.store.getTemplate("fixture-echo");
  if (!found || !template) throw new Error("Missing fixture");
  await server.store.updatePrincipal(found.principal.id, [...found.principal.scopes, "display:view"], ["*"]);
  await server.store.upsertTemplate({
    ...template,
    version: "2.0.0",
    digest: `sha256:${"e".repeat(64)}`,
    spec: { ...template.spec, display: { mode: "desktop" } },
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
  const open = (control: boolean) =>
    server.app.request(
      `/v1/workspaces/${id}/display`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control }),
      }),
    );
  expect((await open(true)).status).toBe(403);
  const minted = await open(false);
  expect(minted.status).toBe(201);
  const { url } = (await minted.json()) as { url: string };
  expect(new URL(url).hostname).toBe(`${id.replaceAll("-", "")}-display.localhost`);
  const exchange = await server.app.request(url);
  expect(exchange.status).toBe(303);
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
  const page = await server.app.request(new URL("/", url), { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("PocketCoder desktop");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await server.app.request(new URL("/workspace.html", url), { headers: { cookie } })).status).toBe(404);
  expect((await server.app.request(url)).status).toBe(401);
  await server.store.updatePrincipal(found.principal.id, found.principal.scopes, ["*"]);
  expect((await server.app.request(new URL("/", url), { headers: { cookie } })).status).toBe(401);
});
