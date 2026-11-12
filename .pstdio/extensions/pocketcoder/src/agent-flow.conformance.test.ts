import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessEventSink, JsonPatch, ResourceAnchor } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { buildLocalImage } from "../../../../examples/local/runtime";
import { qualifySessionTemplate } from "../../../../examples/local/session-template";
import { createMachineHarness } from "./agent";
import { createInstances } from "./instances";
import { createLabCommands } from "./lab-commands";
import { createMachineProvider, machinePath, machineRef } from "./machines";

const repo = resolve(import.meta.dir, "../../../..");
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(stderr);
  return stdout.trim();
};

const buildImage = async () => {
  await command([
    "bun",
    "build",
    "packages/supervisor/src/index.ts",
    "--target",
    "bun",
    "--outdir",
    "deploy/image/dist",
  ]);
  const imageTag = `pocketcoder-pstdio-echo:test-${randomUUID()}`;
  const { imageId: image } = await buildLocalImage({ root: repo, imageTag, context: "deploy/image" });
  return { imageTag, image };
};

const machineContext = () => {
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "test",
    overrides: { extensionId: "pocketcoder.pocketcoder" },
  });
  const anchors = new Map<string, ResourceAnchor[]>();
  ctx.workspaces.addAnchors = async (id, added) => {
    anchors.set(id, [...(anchors.get(id) ?? []), ...added]);
  };
  ctx.workspaces.list = async () =>
    [...anchors].map(([id, anchors_json]) => ({
      id,
      provider_id: `${ctx.extensionId}.workspace-type.machine`,
      anchors_json,
    }));
  return { ctx, anchors };
};

test("launches a Docker agent in a selected instance, connects, follows up, and deletes it", async () => {
  const { imageTag, image } = await buildImage();
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-agent-flow-"));
  const instances = createInstances(join(root, "instances"));
  const provider = createMachineProvider(() => instances);
  const harness = createMachineHarness(() => instances);
  const { ctx, anchors } = machineContext();
  const stateValues = createMemoryStorage();
  const harnessCtx = {
    ...ctx,
    logger: console,
    state: {
      async get<T>(key: string) {
        return await stateValues.get<T>(key);
      },
      async set(key: string, value: unknown) {
        await stateValues.set(key, value);
      },
      async delete(key: string) {
        await stateValues.delete(key);
      },
    },
  };
  let instanceId: string | undefined;
  let ref: Awaited<ReturnType<typeof provider.create>>["providerRef"] | undefined;
  try {
    const templates = join(root, "templates");
    await mkdir(templates);
    let template = JSON.parse(await readFile(join(repo, "examples/harnesses/echo/template.json"), "utf8"));
    template = await qualifySessionTemplate(template, `${imageTag}@${image}`);
    await writeFile(join(templates, "echo.json"), JSON.stringify(template));
    const instance = await instances.launch({
      name: "Agent flow",
      manifests: [template],
      binary: join(repo, "out/native/pocketcoder"),
      templates,
    });
    instanceId = instance.id;
    const input = {
      operationId: randomUUID(),
      projectId: "test",
      workspaceId: randomUUID(),
      params: { instance: instance.id, template: "echo-harness" },
    };
    anchors.set(input.workspaceId, []);
    const created = await provider.create(ctx, input);
    ref = created.providerRef;
    expect(ref).toBeDefined();
    if (!ref) throw new Error("No machine reference");
    const lab = await createLabCommands(() => instances).read.run(ctx, {});
    expect(lab.machines.map((row) => row.id)).toEqual([machineRef(ref).machineId]);
    const again = await provider.create(ctx, input);
    expect(again.providerRef).toEqual(ref);
    let resolved = await provider.resolve(ctx, { ...input, providerRef: ref });
    const deadline = Date.now() + 60_000;
    while (resolved.state === "provisioning" && Date.now() < deadline) {
      await Bun.sleep(200);
      resolved = await provider.resolve(ctx, { ...input, providerRef: ref });
    }
    expect(resolved.state).toBe("ready");
    if (resolved.executionTarget?.kind !== "remote") throw new Error("No remote target");
    const patches: JsonPatch[] = [];
    const events: HarnessEventSink = {
      push(patch) {
        patches.push(patch);
      },
      getMessages: () => [],
    };
    const sessionId = randomUUID();
    const workspace = { workspaceId: input.workspaceId, executionTarget: resolved.executionTarget };
    const connection = await harness.start(harnessCtx, { sessionId, workspace, prompt: "", events });
    expect(await connection.done).toEqual({ status: "completed" });
    expect(
      await harness.getMessages(harnessCtx, { workspace, agentSessionId: connection.agentSessionId ?? "" }),
    ).toEqual([]);
    const session = await harness.resume(harnessCtx, {
      sessionId,
      workspace,
      agentSessionId: connection.agentSessionId ?? "",
      prompt: "first hello",
      events,
    });
    expect(await session.done).toEqual({ status: "completed" });
    expect(JSON.stringify(patches)).toContain("echo: first hello");
    const followup = await harness.resume(harnessCtx, {
      sessionId,
      workspace,
      agentSessionId: session.agentSessionId ?? "",
      prompt: "second hello",
      events,
    });
    expect(await followup.done).toEqual({ status: "completed" });
    expect(JSON.stringify(patches)).toContain("echo: second hello");
    await expect(harness.start(harnessCtx, { sessionId, prompt: "wrong machine", events })).rejects.toThrow();
    await provider.delete(ctx, { ...input, providerRef: ref });
    const deleted = await provider.resolve(ctx, { ...input, providerRef: ref });
    expect(deleted.state).toBe("cancelled");
    expect(
      JSON.stringify(
        await harness.getMessages(harnessCtx, { workspace, agentSessionId: session.agentSessionId ?? "" }),
      ),
    ).toContain("echo: second hello");
    ref = undefined;
  } finally {
    if (ref)
      await provider.delete(ctx, {
        projectId: "test",
        workspaceId: "test",
        operationId: randomUUID(),
        providerRef: ref,
      });
    if (instanceId) await instances.stop(instanceId);
    await rm(root, { recursive: true, force: true });
    await command(["docker", "image", "rm", imageTag]);
  }
}, 180_000);
