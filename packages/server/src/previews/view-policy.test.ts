import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ViewPolicy } from "./view-policy";

const config = {
  apiOrigin: "https://api.example.org",
  origin: "https://views.example.net",
  parents: ["https://app.example.org"],
  trustedIngress: ["127.0.0.1"],
};

async function inspectIngress(trustedIngress: string[], headers: Record<string, string>) {
  const policy = new ViewPolicy({ ...config, trustedIngress });
  const app = new Hono();
  app.onError((error, c) => c.json({ error: String(error) }, 400));
  app.get("*", (c) => {
    const url = policy.requestUrl(c);
    return c.json({ origin: url.origin, host: policy.host(url) });
  });
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => app.fetch(request, server),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/`, { headers });
    return {
      status: response.status,
      body: (await response.json()) as { origin: string; host?: { name?: string; invalid?: boolean } },
      localOrigin: `http://127.0.0.1:${listener.port}`,
    };
  } finally {
    await listener.stop(true);
  }
}

test("real untrusted peers cannot select a public origin with forwarded headers", async () => {
  const response = await inspectIngress(["192.0.2.1"], {
    "x-forwarded-host": `${"a".repeat(32)}-web.views.example.net`,
    "x-forwarded-proto": "https",
    forwarded: "host=api.example.org;proto=https",
  });
  expect(response.status).toBe(200);
  expect(response.body.origin).toBe(response.localOrigin);
  expect(response.body.host).toBeUndefined();
});

test("real configured ingress peers select only a valid HTTPS forwarded origin", async () => {
  const accepted = await inspectIngress(["127.0.0.1"], {
    "x-forwarded-host": `${"a".repeat(32)}-web.views.example.net`,
    "x-forwarded-proto": "https",
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body.origin).toBe(`https://${"a".repeat(32)}-web.views.example.net`);
  expect(accepted.body.host).toEqual({ name: "web" });
  const rejected: Record<string, string>[] = [
    { "x-forwarded-host": "api.example.org", "x-forwarded-proto": "http" },
    { "x-forwarded-host": "api.example.org, attacker.example", "x-forwarded-proto": "https" },
    { "x-forwarded-host": "attacker@api.example.org", "x-forwarded-proto": "https" },
    { "x-forwarded-host": "api.example.org" },
    { "x-forwarded-proto": "https" },
  ];
  for (const headers of rejected) expect((await inspectIngress(["127.0.0.1"], headers)).status).toBe(400);
});

test("real peers inside a configured ingress range may forward the public origin", async () => {
  const forwarded = { "x-forwarded-host": `${"a".repeat(32)}-web.views.example.net`, "x-forwarded-proto": "https" };
  const inside = await inspectIngress(["127.0.0.0/8"], forwarded);
  expect(inside.body.origin).toBe(`https://${"a".repeat(32)}-web.views.example.net`);
  const outside = await inspectIngress(["10.244.0.0/16"], forwarded);
  expect(outside.body.origin).toBe(outside.localOrigin);
});

test("ingress WebSocket upgrades forwarded as wss keep the HTTPS origin", async () => {
  const host = `${"a".repeat(32)}-display.views.example.net`;
  const secure = await inspectIngress(["127.0.0.1"], { "x-forwarded-host": host, "x-forwarded-proto": "wss" });
  expect(secure.body.origin).toBe(`https://${host}`);
  expect(secure.body.host).toEqual({ name: "display" });
  expect((await inspectIngress(["127.0.0.1"], { "x-forwarded-host": host, "x-forwarded-proto": "ws" })).status).toBe(
    400,
  );
});

test("public hosts reject nested labels, wrong ports, and insecure transport", () => {
  const policy = new ViewPolicy(config);
  const label = `${"b".repeat(32)}-display`;
  expect(policy.host(new URL(`https://${label}.views.example.net`))).toEqual({ name: "display" });
  for (const origin of [
    `https://other.${label}.views.example.net`,
    `https://${label}.views.example.net:444`,
    `http://${label}.views.example.net`,
    "https://views.example.net",
    `https://${label}.localhost`,
  ])
    expect(policy.host(new URL(origin))).toEqual({ invalid: true });
  expect(policy.host(new URL(`https://${label}.views.example.net.attacker.org`))).toBeUndefined();
});

test("HTTPS minting replaces the API port with the configured view port", () => {
  const policy = new ViewPolicy({ ...config, apiOrigin: "https://api.example.org:8443" });
  const minted = policy.mintUrl(
    new URL("https://api.example.org:8443/v1/workspaces/id/display"),
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    "display",
    { mode: "top_level" },
  );
  expect(minted.origin).toBe(`https://${"b".repeat(32)}-display.views.example.net`);
  expect(policy.host(minted)).toEqual({ name: "display" });
});
