import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();
const publicViews = {
  apiOrigin: "https://api.pocketcoder.example",
  origin: "https://views.example.net",
  parents: ["https://app.example.org"],
  trustedIngress: [],
};

test("HTTPS display sessions isolate cookies and bind embedding to one parent", async () => {
  const server = await createTestServer(await createStore(), {}, undefined, { publicViews });
  const found = await server.store.getMachineKeyWithPrincipal(server.keyId);
  const template = await server.store.getTemplate("fixture-echo");
  if (!found || !template) throw new Error("Missing fixture");
  await server.store.updatePrincipal(found.principal.id, [...found.principal.scopes, "display:view"], ["*"]);
  await server.store.upsertTemplate({
    ...template,
    version: "2.0.0",
    digest: `sha256:${"f".repeat(64)}`,
    spec: { ...template.spec, display: { mode: "browser" } },
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
  const open = (session: object) =>
    server.app.request(
      `${publicViews.apiOrigin}/v1/workspaces/${id}/display`,
      authed(server.token, { method: "POST", body: JSON.stringify({ control: false, session }) }),
    );
  expect(
    (
      await server.app.request(
        `http://127.0.0.1/v1/workspaces/${id}/display`,
        authed(server.token, {
          method: "POST",
          headers: { "x-forwarded-proto": "https", "x-forwarded-host": "api.pocketcoder.example" },
          body: JSON.stringify({ session: { mode: "top_level" } }),
        }),
      )
    ).status,
  ).toBe(400);
  expect((await open({ mode: "local" })).status).toBe(400);
  expect((await server.app.request("https://1234-display.views.example.net/worker.js")).status).toBe(404);
  expect((await open({ mode: "embedded", parentOrigin: "https://sibling.example.org" })).status).toBe(400);
  for (const mode of ["top_level", "embedded"]) {
    const minted = await open({ mode, ...(mode === "embedded" ? { parentOrigin: publicViews.parents[0] } : {}) });
    expect(minted.status).toBe(201);
    const { url } = (await minted.json()) as { url: string };
    expect(new URL(url).hostname).toBe(`${id.replaceAll("-", "")}-display.views.example.net`);
    const exchanged = await server.app.request(url);
    expect(exchanged.status).toBe(303);
    const header = exchanged.headers.get("set-cookie") ?? "";
    expect(header).toStartWith("__Host-pc-view=");
    expect(header).toContain("Secure");
    expect(header).not.toContain("Domain=");
    expect(header).toContain(mode === "embedded" ? "SameSite=None" : "SameSite=Lax");
    expect(header.includes("Partitioned")).toBe(mode === "embedded");
    const cookie = header.split(";")[0] ?? "";
    const sibling = new URL("/", url);
    sibling.hostname = sibling.hostname.replace(id.replaceAll("-", ""), "0".repeat(32));
    expect((await server.app.request(sibling, { headers: { cookie } })).status).toBe(401);
    const page = await server.app.request(new URL("/", url), { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      mode === "embedded" ? "frame-ancestors 'self' https://app.example.org" : "frame-ancestors 'none'",
    );
    expect(await page.text()).toContain("PocketCoder browser");
    expect((await server.app.request(new URL("/worker.js", url), { headers: { cookie } })).status).toBe(404);
    expect(
      (
        await server.app.request(new URL("/socket", url), {
          headers: {
            cookie,
            upgrade: "websocket",
            origin: "https://sibling.views.example.net",
          },
        })
      ).status,
    ).toBe(401);
    if (mode === "embedded") {
      const clean = new URL(exchanged.headers.get("location") ?? "", url);
      expect(clean.search).not.toContain("token");
      const blocked = await server.app.request(clean);
      expect(blocked.status).toBe(200);
      expect(await blocked.text()).toContain("Open in a new tab");
      expect(blocked.headers.get("content-security-policy")).toContain(publicViews.parents[0] ?? "");
    }
    await server.store.updatePrincipal(found.principal.id, found.principal.scopes, ["*"]);
    expect((await server.app.request(new URL("/", url), { headers: { cookie } })).status).toBe(401);
    await server.store.updatePrincipal(found.principal.id, [...found.principal.scopes, "display:view"], ["*"]);
  }
});
