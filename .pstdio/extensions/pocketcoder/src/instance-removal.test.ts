import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createRemoveInstance } from "./instance-removal";
import { createInstances } from "./instances";

test("remove hides only a stopped instance, preserves its data, and clears its selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-remove-instance-"));
  const instances = createInstances(root);
  const remove = createRemoveInstance(() => instances);
  let instanceId = "";
  try {
    const instance = await instances.launch({
      name: "removal test",
      binary: resolve(import.meta.dir, "../../../../out/native/pocketcoder"),
    });
    instanceId = instance.id;
    const storage = createMemoryStorage();
    await storage.set("selected-instance", instanceId);
    const ctx = makeCommandContext({
      params: {},
      storage,
      projectId: randomUUID(),
      overrides: { extensionId: "pocketcoder.pocketcoder", resource: { type: "instance", id: instanceId } },
    });
    await expect(remove.run(ctx, {})).rejects.toThrow("Stop the instance before removing it");
    expect(await storage.get<string>("selected-instance")).toBe(instanceId);
    expect((await instances.list()).map((row) => row.id)).toEqual([instanceId]);

    const processState = JSON.parse(await readFile(join(root, instanceId, "state/server.json"), "utf8"));
    process.kill(processState.pid, "SIGSTOP");
    try {
      await expect(remove.run(ctx, {})).rejects.toThrow("Stop the instance before removing it");
    } finally {
      process.kill(processState.pid, "SIGCONT");
    }

    await instances.stop(instanceId);
    const checkpoint = join(root, instanceId, "checkpoints/keep.txt");
    await mkdir(join(root, instanceId, "checkpoints"), { recursive: true });
    await writeFile(checkpoint, "saved checkpoint");
    expect(await remove.run(ctx, {})).toEqual({ instanceId, removed: true });
    expect(await instances.list()).toEqual([]);
    expect(await storage.get<string>("selected-instance")).toBeUndefined();
    expect(await readFile(checkpoint, "utf8")).toBe("saved checkpoint");
    expect((await instances.get(instanceId)).state).toBe("stopped");

    await instances.start(instanceId);
    expect((await instances.list()).map((row) => row.id)).toEqual([instanceId]);
  } finally {
    if (instanceId) await instances.stop(instanceId);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a failed launch with a missing executable can be removed without changing another selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-remove-failed-instance-"));
  const id = randomUUID();
  try {
    await mkdir(join(root, id));
    await writeFile(
      join(root, id, "instance.json"),
      JSON.stringify({
        id,
        name: "failed",
        binary: join(root, "missing"),
        url: "http://127.0.0.1:1",
        agentPort: 2,
        state: "stopped",
      }),
    );
    const instances = createInstances(root);
    const storage = createMemoryStorage();
    await storage.set("selected-instance", "another-instance");
    const ctx = makeCommandContext({ params: {}, storage, projectId: randomUUID() });
    await createRemoveInstance(() => instances).run(ctx, { instanceId: id });
    expect(await instances.list()).toEqual([]);
    expect(await storage.get<string>("selected-instance")).toBe("another-instance");
    expect(await Bun.file(join(root, id, "instance.json")).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an instance whose saved executable is gone can be removed once its controller process has exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-remove-moved-instance-"));
  const id = randomUUID();
  try {
    await mkdir(join(root, id, "state"), { recursive: true });
    await writeFile(
      join(root, id, "instance.json"),
      JSON.stringify({
        id,
        name: "moved",
        binary: join(root, "missing"),
        url: "http://127.0.0.1:1",
        agentPort: 2,
        state: "stopped",
      }),
    );
    const instances = createInstances(root);
    const ctx = makeCommandContext({ params: {}, storage: createMemoryStorage(), projectId: randomUUID() });
    const remove = createRemoveInstance(() => instances);

    // This test process is alive, so removal must still refuse.
    await writeFile(join(root, id, "state/server.json"), JSON.stringify({ pid: process.pid }));
    await expect(remove.run(ctx, { instanceId: id })).rejects.toThrow("Stop the instance before removing it");

    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(root, id, "state/server.json"), JSON.stringify({ pid: exited.pid }));
    expect(await remove.run(ctx, { instanceId: id })).toEqual({ instanceId: id, removed: true });
    expect(await instances.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
