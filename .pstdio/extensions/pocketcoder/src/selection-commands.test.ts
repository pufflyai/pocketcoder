import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createInstances } from "./instances";
import { createSelectionCommands } from "./selection-commands";

const repo = resolve(import.meta.dir, "../../../..");
const binary = join(repo, "out/native/pocketcoder");
const context = () => makeCommandContext({ projectId: "test", storage: createMemoryStorage(), params: {} });

test("selected instances stop, start and are removed together, and one bad row does not block the others", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-selected-instances-"));
  const instances = createInstances(root);
  const commands = createSelectionCommands(() => instances);
  try {
    const [a, b] = await Promise.all([
      instances.launch({ name: "A", binary }),
      instances.launch({ name: "B", binary }),
    ]);
    const rowIds = [a.id, b.id];
    await expect(commands.stopSelected.run(context(), { rowIds: [...rowIds, "not-an-instance"] })).rejects.toThrow(
      "1 of 3",
    );
    expect((await instances.list()).map((instance) => instance.state)).toEqual(["stopped", "stopped"]);
    await commands.startSelected.run(context(), { rowIds });
    expect((await instances.list()).map((instance) => instance.state)).toEqual(["running", "running"]);
    await commands.stopSelected.run(context(), { rowIds });
    await commands.removeSelected.run(context(), { rowIds });
    expect(await instances.list()).toEqual([]);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("removing published templates retires those versions and hides them from the instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-retire-templates-"));
  const instances = createInstances(root);
  const commands = createSelectionCommands(() => instances);
  const manifest = await Bun.file(join(repo, "examples/workloads/finite-process.json")).json();
  const named = (name: string) => ({
    ...manifest,
    metadata: { ...manifest.metadata, name },
    spec: { ...manifest.spec, network: { mode: "unrestricted" } },
  });
  try {
    const { id } = await instances.launch({
      name: "Templates",
      binary,
      manifests: [named("a"), named("b"), named("c")],
    });
    await commands.retireTemplateRow.run(context(), { rowId: `${id}:a@1.0.0` });
    await commands.retireSelectedTemplates.run(context(), { rowIds: [`${id}:b@1.0.0`] });
    expect((await instances.publishedTemplates(id)).map((template) => template.name)).toEqual(["c"]);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
