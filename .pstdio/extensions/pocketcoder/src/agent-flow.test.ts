import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessEventSink, JsonPatch } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createMachineHarness } from "./agent";
import { createInstances } from "./instances";
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
  await command(["docker", "build", "-t", imageTag, "deploy/image"]);
  const image = await command(["docker", "image", "inspect", imageTag, "--format", "{{.Id}}"]);
  return { imageTag, image };
};

test("launches a Docker agent in a selected instance, connects, follows up, and deletes it", async () => {
  const { imageTag, image } = await buildImage();
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-agent-flow-"));
  const instances = createInstances(join(root, "instances"));
  const provider = createMachineProvider(() => instances);
  const harness = createMachineHarness(() => instances);
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "test",
    overrides: { extensionId: "pocketcoder.pocketcoder" },
  });
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
    const template = JSON.parse(await readFile(join(repo, "examples/harnesses/echo/template.json"), "utf8"));
    template.spec.image = `${imageTag}@${image}`;
    await writeFile(join(templates, "echo.json"), JSON.stringify(template));
    const instance = await instances.launch({
      name: "Agent flow",
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
    const created = await provider.create(ctx, input);
    ref = created.providerRef;
    expect(ref).toBeDefined();
    if (!ref) throw new Error("No machine reference");
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
    const initial = await instances.request<{ messages: unknown[] }>(
      instance.id,
      `${machinePath(machineRef(ref).machineId)}/agent/messages`,
    );
    expect(initial.messages).toEqual([]);
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
    await expect(harness.start(harnessCtx, { sessionId, prompt: "wrong machine", events })).rejects.toThrow("Choose");
    await provider.delete(ctx, { ...input, providerRef: ref });
    const deleted = await provider.resolve(ctx, { ...input, providerRef: ref });
    expect(deleted.state).toBe("cancelled");
    expect(
      JSON.stringify(
        await harness.getMessages(harnessCtx, { workspace, agentSessionId: session.agentSessionId ?? "" }),
      ),
    ).toContain("echo: second hello");
    ref = undefined;

    const delayed = structuredClone(template);
    delayed.metadata.name = "delayed-agent";
    delayed.spec.harness.command = [
      "bun",
      "-e",
      `
      let status = "stable";
      const messages = [];
      Bun.serve({ hostname: "127.0.0.1", port: 3284, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/status") return Response.json({ status });
        if (path === "/messages") return Response.json({ messages });
        if (path === "/message") {
          const { content } = await request.json();
          messages.push({ role: "user", content });
          status = "running";
          setTimeout(() => { messages.push({ role: "agent", content: "finished: " + content }); status = "stable"; }, 2500);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      }});
    `,
    ];
    await writeFile(join(templates, "delayed.json"), JSON.stringify(delayed));
    await instances.importTemplates(instance.id, templates);
    const delayedInput = {
      ...input,
      workspaceId: randomUUID(),
      operationId: randomUUID(),
      params: { instance: instance.id, template: "delayed-agent" },
    };
    const delayedMachine = await provider.create(ctx, delayedInput);
    ref = delayedMachine.providerRef;
    const delayedTarget = delayedMachine.executionTarget;
    if (!ref || delayedTarget?.kind !== "remote") throw new Error("No delayed agent target");
    const delayedWorkspace = { workspaceId: delayedInput.workspaceId, executionTarget: delayedTarget };
    const delayedSession = await harness.start(harnessCtx, {
      sessionId,
      workspace: delayedWorkspace,
      prompt: "pending turn",
      events,
    });
    const delayedRef = machineRef(ref);
    let status = "stable";
    while (status !== "running") {
      const response = await instances.request<{ status: string }>(
        instance.id,
        `${machinePath(delayedRef.machineId)}/agent/status`,
      );
      status = response.status;
      if (status !== "running") await Bun.sleep(50);
    }
    await delayedSession.stop();
    expect(await delayedSession.done).toEqual({ status: "disconnected" });
    expect((await provider.resolve(ctx, { ...delayedInput, providerRef: ref })).state).toBe("ready");
    const attached = await harness.reattach(harnessCtx, {
      sessionId,
      workspace: delayedWorkspace,
      agentSessionId: delayedSession.agentSessionId ?? "",
      events,
    });
    expect(await attached.done).toEqual({ status: "completed" });
    const messages = await instances.request<{ messages: { content: string }[] }>(
      instance.id,
      `${machinePath(delayedRef.machineId)}/agent/messages`,
    );
    expect(messages.messages.map((message) => message.content)).toEqual(["pending turn", "finished: pending turn"]);
    const reloadTurn = await harness.resume(harnessCtx, {
      sessionId,
      workspace: delayedWorkspace,
      agentSessionId: delayedSession.agentSessionId ?? "",
      prompt: "reload turn",
      events,
    });
    while (
      (await instances.request<{ status: string }>(instance.id, `${machinePath(delayedRef.machineId)}/agent/status`))
        .status !== "running"
    )
      await Bun.sleep(50);
    await harness.dispose(harnessCtx);
    expect(await reloadTurn.done).toEqual({ status: "disconnected" });
    const replacement = createMachineHarness(() => instances);
    const recovered = await replacement.reattach(harnessCtx, {
      sessionId,
      workspace: delayedWorkspace,
      agentSessionId: reloadTurn.agentSessionId ?? "",
      events,
    });
    expect(await recovered.done).toEqual({ status: "completed" });
    await provider.delete(ctx, { ...delayedInput, providerRef: ref });
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
