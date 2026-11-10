import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInstances } from "./instances";

const binary = resolve(import.meta.dir, "../../../../out/native/pocketcoder");

test("invalid current template limits fail before creating or starting an instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-invalid-limits-"));
  try {
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
    ).json();
    const instances = createInstances(root);
    for (const key of [
      "stagedInputBytes",
      "inputFiles",
      "inputFileBytes",
      "inFlightTransfers",
      "finalizationSeconds",
      "unreferencedInputRetentionSeconds",
    ]) {
      for (const value of [undefined, NaN, Infinity, 0, "10"]) {
        const source = structuredClone(manifest);
        source.spec.limits[key] = value;
        await expect(
          instances.launch({ name: "invalid", binary: "/missing-binary", manifest: source }),
        ).rejects.toThrow(`Template limits.${key}`);
        expect(await readdir(root)).toEqual([]);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("starting with a missing executable keeps the saved one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-bad-override-"));
  const id = randomUUID();
  try {
    await mkdir(join(root, id));
    const saved = { id, name: "saved", binary, url: "http://127.0.0.1:1", agentPort: 2, state: "stopped" };
    await writeFile(join(root, id, "instance.json"), JSON.stringify(saved));
    await expect(createInstances(root).start(id, join(root, "missing"))).rejects.toThrow(
      "PocketCoder executable not found",
    );
    expect(JSON.parse(await readFile(join(root, id, "instance.json"), "utf8")).binary).toBe(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
