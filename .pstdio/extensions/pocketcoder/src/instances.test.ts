import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInstances } from "./instances";

const binary = resolve(import.meta.dir, "../../../../out/native/pocketcoder");

test("starts isolated 1.0 instances with private, expiring owner keys and restarts one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-extension-"));
  const instances = createInstances(root);
  try {
    const first = await instances.launch({ name: "First", binary });
    const second = await instances.launch({ name: "Second", binary });
    expect(first.url).not.toBe(second.url);
    expect(first.agentPort).not.toBe(second.agentPort);
    expect(first).not.toHaveProperty("token");
    expect((await instances.list()).map((item) => item.name).sort()).toEqual(["First", "Second"]);
    const auth = JSON.parse(await readFile(join(root, first.id, "owner.json"), "utf8"));
    expect(Date.parse(auth.expiresAt)).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect((await stat(join(root, first.id, "owner.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, first.id))).mode & 0o777).toBe(0o700);
    expect(await instances.request(first.id, "/v1/templates")).toMatchObject({ items: [] });
    await instances.stop(first.id);
    expect((await instances.get(first.id)).state).toBe("stopped");
    await instances.start(first.id);
    expect((await instances.get(first.id)).state).toBe("running");
    expect(await instances.request(first.id, "/v1/templates")).toMatchObject({ items: [] });
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
