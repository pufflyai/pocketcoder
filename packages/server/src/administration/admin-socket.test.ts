import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdminSocket } from "./admin-socket";

test("admin shutdown refuses a foreign socket and can retry after its original path is restored", async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "pc-admin-owner-")));
  const admin = await startAdminSocket(directory, () => new Response("original"));
  const original = join(directory, "original.sock");
  let other: ReturnType<typeof Bun.serve> | undefined;
  try {
    await rename(admin.path, original);
    other = Bun.serve({ unix: admin.path, fetch: () => new Response("foreign") });
    await expect(admin.stop()).rejects.toThrow("replaced");
    expect(existsSync(admin.path)).toBe(true);
    expect(
      await (await fetch("http://localhost/check", { unix: admin.path, headers: { connection: "close" } })).text(),
    ).toBe("foreign");
    await other.stop(true);
    other = undefined;
    await rename(original, admin.path);
    await admin.stop();
    expect(existsSync(admin.path)).toBe(false);
  } finally {
    await other?.stop(true);
    if (existsSync(original) && !existsSync(admin.path)) await rename(original, admin.path);
    await admin.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("admin shutdown waits for an admitted handler after its network connection closes", async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "pc-admin-drain-")));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let handlerFinished = false;
  const admin = await startAdminSocket(directory, async () => {
    entered.resolve();
    await release.promise;
    handlerFinished = true;
    return new Response("done");
  });
  const request = fetch("http://localhost/check", { unix: admin.path }).catch(() => undefined);
  let stopped = false;
  try {
    await entered.promise;
    const stop = admin.stop().then(() => {
      stopped = true;
    });
    await request;
    expect(stopped).toBe(false);
    expect(handlerFinished).toBe(false);
    release.resolve();
    await stop;
    expect(handlerFinished).toBe(true);
    expect(stopped).toBe(true);
  } finally {
    release.resolve();
    await request;
    await admin.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
