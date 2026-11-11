import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryRepoFiles, createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createInstanceCommands } from "./instance-commands";
import { createInstances } from "./instances";
import { templateDirectory } from "./template-catalog";

const repo = resolve(import.meta.dir, "../../../..");
const binary = join(repo, "out/native/pocketcoder");

test("Launch instance publishes several catalog templates and Add template publishes one more", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-instance-commands-"));
  const instances = createInstances(root);
  const commands = createInstanceCommands(() => instances);
  const files = createMemoryRepoFiles();
  const ctx = makeCommandContext({
    projectId: "test",
    storage: createMemoryStorage(),
    params: {},
    overrides: { projectFiles: files },
  });
  const manifest = await Bun.file(join(repo, "examples/workloads/finite-process.json")).json();
  for (const name of ["echo", "relay", "extra"])
    await files.writeText(
      `${templateDirectory}/${name}.json`,
      JSON.stringify({
        ...manifest,
        metadata: { ...manifest.metadata, name },
        spec: { ...manifest.spec, network: { mode: "unrestricted" } },
      }),
    );
  try {
    const instance = await commands.launchInstance.run(ctx, {
      name: "Several",
      binary,
      templates: [`${templateDirectory}/echo.json`, `${templateDirectory}/relay.json`],
    });
    await commands.publishTemplate.run(ctx, { instance: instance.id, template: `${templateDirectory}/extra.json` });
    const templates = await instances.items<{ name: string }>(instance.id, "/v1/templates");
    expect(templates.map((template) => template.name).sort()).toEqual(["echo", "extra", "relay"]);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("Start instance switches to a newly chosen executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-start-binary-"));
  const instances = createInstances(root);
  const commands = createInstanceCommands(() => instances);
  const ctx = makeCommandContext({ projectId: "test", storage: createMemoryStorage(), params: {} });
  try {
    const { id } = await instances.launch({ name: "Moved", binary });
    await instances.stop(id);
    const path = join(root, id, "instance.json");
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), binary: join(root, "gone") }));
    expect((await commands.startInstance.run(ctx, { instanceId: id, binary })).state).toBe("running");
    expect(JSON.parse(await readFile(path, "utf8")).binary).toBe(binary);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
