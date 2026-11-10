import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOnefin } from "./start";

test("Onefin revokes an acquired lease if local startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "onefin-start-"));
  const blocked = join(root, "blocked");
  await writeFile(blocked, "file");
  const revoked: string[] = [];
  const credential = `test.${Buffer.from(JSON.stringify({ jti: "startup", exp: Date.now() / 1000 + 3600, task_id: "task" })).toString("base64url")}.test`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("revoke/")) {
        revoked.push(((await request.json()) as { jti: string }).jti);
        return new Response(null, { status: 204 });
      }
      return Response.json({ access_token: credential });
    },
  });
  try {
    await expect(
      startOnefin({ onefin_api_url: server.url.toString(), bootstrap_code: "once", task_id: "task" }, blocked),
    ).rejects.toThrow();
    expect(revoked).toEqual(["startup"]);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("Onefin revokes a lease redeemed while startup is stopping", async () => {
  const redeeming = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const revoked: string[] = [];
  const revoking = Promise.withResolvers<void>();
  const finishRevocation = Promise.withResolvers<void>();
  const credential = `test.${Buffer.from(JSON.stringify({ jti: "stopped-startup", exp: Date.now() / 1000 + 3600, task_id: "task" })).toString("base64url")}.test`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("revoke/")) {
        revoking.resolve();
        await finishRevocation.promise;
        revoked.push(((await request.json()) as { jti: string }).jti);
        return new Response(null, { status: 204 });
      }
      redeeming.resolve();
      await release.promise;
      return Response.json({ access_token: credential });
    },
  });
  const child = Bun.spawn([process.execPath, new URL("./start.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      POCKETCODER_LAUNCH_INPUT: JSON.stringify({
        onefin_api_url: server.url.toString(),
        bootstrap_code: "once",
        task_id: "task",
      }),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await redeeming.promise;
    child.kill("SIGTERM");
    release.resolve();
    await revoking.promise;
    child.kill("SIGTERM");
    finishRevocation.resolve();
    expect(await child.exited).toBe(0);
    expect(revoked).toEqual(["stopped-startup"]);
  } finally {
    release.resolve();
    finishRevocation.resolve();
    child.kill("SIGKILL");
    await child.exited;
    await server.stop(true);
  }
});
