import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";

async function controller(directory: string) {
  const script = `import { startPocketCoderServer } from './packages/server/src/lifecycle/lifecycle';
    import { loadConfig } from './packages/server/src/config/config';
    const running = await startPocketCoderServer({...loadConfig(),listenPort:0,agentPort:0},{log:()=>{}});
    console.log(JSON.stringify({url:running.url}));
    process.on('SIGTERM', async()=>{await running.stop();process.exit(0)});`;
  const child = Bun.spawn(["bun", "--no-env-file", "-e", script], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: { ...process.env, POCKETCODER_DIR: directory, DOCKER_HOST: `unix://${directory}/unreachable-docker.sock` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let url: string;
  try {
    const line = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Controller startup timed out")), 10_000);
      }),
    ]);
    if (!line.value) throw new Error(`Controller exited: ${await new Response(child.stderr).text()}`);
    url = (JSON.parse(new TextDecoder().decode(line.value)) as { url: string }).url;
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    await reader.cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return {
    url,
    async stop() {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    },
  };
}

test("an admitted launch settles behind a durable fence; unreachable runtime stays pending after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-account-fence-"));
  let running: Awaited<ReturnType<typeof controller>> | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    running = await controller(directory);
    const admin = (path: string, body: object) =>
      fetch(`http://localhost${path}`, {
        unix: join(directory, "admin.sock"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const owner = await admin("/v1/owner", {
      request_id: crypto.randomUUID(),
      automation: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(owner.status).toBe(201);
    const { token } = (await owner.json()) as { token: string };
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "accepted-launch",
    };
    expect(
      (
        await fetch(`${running.url}/v1/templates`, {
          method: "POST",
          headers,
          body: JSON.stringify({ manifest: fixtureTemplateEcho().manifest }),
        })
      ).status,
    ).toBe(201);
    const launch = fetch(`${running.url}/v1/workspaces`, {
      method: "POST",
      headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode('{"external_id":'));
        },
      }),
    });
    launch.catch(() => {});
    const admittedDeadline = Date.now() + 5000;
    while (true) {
      const status = await fetch("http://localhost/v1/account", { unix: join(directory, "admin.sock") });
      const account = (await status.json()) as { admitted_requests: number };
      if (account.admitted_requests === 1) break;
      if (Date.now() > admittedDeadline) throw new Error("Launch did not enter admission");
      await Bun.sleep(10);
    }
    const input = { request_id: crypto.randomUUID() };
    const suspension = admin("/v1/account/suspend", input);
    const deadline = Date.now() + 5000;
    while (true) {
      const state = await readFile(join(directory, "account-lifecycle.json"), "utf8").catch(() => "");
      if (state.includes('"suspending"')) break;
      if (Date.now() > deadline) throw new Error("Suspension fence was not persisted");
      await Bun.sleep(10);
    }
    expect((await fetch(`${running.url}/v1/workspaces`, { method: "POST", headers, body: "{}" })).status).toBe(503);
    stream?.enqueue(new TextEncoder().encode('"accepted","template":{"name":"fixture-echo"}}'));
    stream?.close();
    expect((await launch).status).toBe(201);
    expect((await suspension).status).toBe(500);
    await running.stop();
    running = await controller(directory);
    expect((await fetch(`${running.url}/v1/workspaces`, { method: "POST", headers, body: "{}" })).status).toBe(503);
    expect((await admin("/v1/account/suspend", input)).status).toBe(500);
    expect(JSON.parse(await readFile(join(directory, "account-lifecycle.json"), "utf8"))).toMatchObject({
      state: "suspending",
      current: { id: input.request_id },
    });
    const listed = await fetch(`${running.url}/v1/workspaces`, { headers });
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { items: { state: string; launch_attempts?: number }[] };
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.state).toBe("queued");
  } finally {
    stream?.error(new Error("Fixture shutting down"));
    await running?.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-journal`, { recursive: true, force: true });
  }
}, 30_000);
