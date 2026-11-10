import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createInstances } from "./instances";
import { createLabCommands } from "./lab-commands";

test("Browse instance uses the selected row without asking for its ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-browse-instance-"));
  const instances = createInstances(root);
  let instanceId = "";
  try {
    const instance = await instances.launch({
      name: "Browse test",
      binary: resolve(import.meta.dir, "../../../../out/native/pocketcoder"),
    });
    instanceId = instance.id;
    const ctx = makeCommandContext({
      projectId: "test",
      storage: createMemoryStorage(),
      params: {},
      overrides: { resource: { type: "instance", id: instanceId } },
    });
    expect(await createLabCommands(() => instances).select.run(ctx, {})).toEqual({ instanceId });
    expect(await ctx.storage.get("selected-instance")).toBe(instanceId);
  } finally {
    if (instanceId) await instances.stop(instanceId);
    await rm(root, { recursive: true, force: true });
  }
});
