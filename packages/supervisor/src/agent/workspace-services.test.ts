import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceServices } from "./workspace-services";

test("a declared website starts from the shell facility, can restart, and stops with its workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc133-services-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  const services = new WorkspaceServices(
    {
      other: { command: [process.execPath, "-e", "process.exit(0)"], env: {} },
      web: {
        command: [process.execPath, "-e", `Bun.serve({port:${port},fetch:()=>new Response('website')});`],
        env: {},
      },
    },
    () => ({}),
    {
      async pump(stream) {
        if (stream)
          for await (const _ of stream) {
          }
      },
    },
    { workspaceId: randomUUID(), incarnationId: "container" },
  );
  const socket = join(root, "control.sock");
  const request = (action: string, name = "web", body: object = { startId: randomUUID() }) =>
    fetch(`http://localhost/${name}/${action}`, { unix: socket, method: "POST", body: JSON.stringify(body) });
  try {
    services.listen(socket);
    expect((await request("start", "undeclared")).status).toBe(404);
    const command = { startId: randomUUID() };
    const receipt = await (await request("start", "web", command)).json();
    expect(await (await request("start", "web", command)).json()).toEqual(receipt);
    expect((await request("start", "other", command)).status).toBe(409);
    expect((await request("start", "web", { ...command, command: ["echo", "injected"] })).status).toBe(400);
    expect((await request("start", "web", { startId: randomUUID() })).status).toBe(409);
    const until = Date.now() + 2000;
    let ready = false;
    while (!ready && Date.now() < until) {
      ready = await fetch(`http://127.0.0.1:${port}`).then(
        (r) => r.ok,
        () => false,
      );
      if (!ready) await Bun.sleep(10);
    }
    expect(ready).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("website");
    const running = (await (await request("status")).json()) as { pid: number };
    process.kill(running.pid, "SIGKILL");
    const stopped = Date.now() + 2000;
    while (((await (await request("status")).json()) as { state: string }).state === "running" && Date.now() < stopped)
      await Bun.sleep(10);
    expect(((await (await request("status")).json()) as { state: string }).state).toBe("exited");
    expect(await (await request("start", "web", command)).json()).toEqual(receipt);
    expect((await request("start")).status).toBe(200);
    await services.close();
    expect(
      await fetch(`http://127.0.0.1:${port}`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await services.close();
    await rm(root, { recursive: true, force: true });
  }
});
