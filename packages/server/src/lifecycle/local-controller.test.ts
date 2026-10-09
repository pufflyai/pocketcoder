import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";

test("empty start issues an owner once, publishes over HTTP and keeps identity on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-local-controller-"));
  let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
  const config = { ...loadConfig({ POCKETCODER_DIR: directory }), listenPort: 0, agentPort: 0 };
  try {
    running = await startPocketCoderServer(config, { log: () => {} });
    expect((await stat(join(directory, "admin.sock"))).mode & 0o777).toBe(0o600);
    const input = {
      request_id: crypto.randomUUID(),
      automation: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const issue = async (body: unknown) =>
      fetch("http://localhost/v1/owner", {
        unix: join(directory, "admin.sock"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await issue({ request_id: crypto.randomUUID(), automation: true })).status).toBe(400);
    const created = await issue(input);
    expect(created.status).toBe(201);
    const owner = (await created.json()) as { token: string; key: { expires_at: string } };
    expect(owner.key.expires_at).toBe(input.expires_at);
    expect(await (await issue(input)).json()).toMatchObject({ token: null });
    const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const template = fixtureTemplateEcho();
    const restricted = {
      ...template.manifest,
      metadata: { name: "restricted-echo" },
      spec: { ...template.manifest.spec, network: { mode: "restricted", allow: [] } },
    };
    const incompatible = await fetch(`${running.url}/v1/templates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ manifest: restricted }),
    });
    expect(incompatible.status).toBe(400);
    expect(await incompatible.json()).toMatchObject({ error: { code: "validation.invalid" } });
    const published = await fetch(`${running.url}/v1/templates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ manifest: template.manifest }),
    });
    expect(published.status).toBe(201);
    expect((await fetch(`${running.url}/v1/agent/connect`, { headers })).status).toBe(404);
    expect((await fetch(`${running.agentUrl}/v1/templates`, { headers })).status).toBe(404);
    expect((await fetch(`${running.agentUrl}/v1/agent/connect`)).status).toBe(401);
    const identity = await readFile(join(directory, "keys", "auth-pepper"));
    await running.stop();
    running = await startPocketCoderServer(config, { log: () => {} });
    expect(await readFile(join(directory, "keys", "auth-pepper"))).toEqual(identity);
    const catalog = await fetch(`${running.url}/v1/templates`, { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ items: [{ digest: template.digest }] });
    expect(await (await issue(input)).json()).toMatchObject({ token: null });
  } finally {
    await running?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("IPv6 listeners return usable operator and agent URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-ipv6-controller-"));
  let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
  try {
    const config = {
      ...loadConfig({
        POCKETCODER_DIR: directory,
        POCKETCODER_HTTP: "[::1]:19080",
        POCKETCODER_AGENT_HTTP: "[::1]:19081",
      }),
      listenPort: 0,
      agentPort: 0,
    };
    running = await startPocketCoderServer(config, { log: () => {} });
    expect(new URL(running.url).hostname).toBe("[::1]");
    expect(new URL(running.agentUrl).hostname).toBe("[::1]");
    expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${running.agentUrl}/v1/agent/connect`)).status).toBe(401);
  } finally {
    await running?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
