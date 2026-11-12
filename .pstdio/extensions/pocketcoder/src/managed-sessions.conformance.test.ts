import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessEventSink, JsonPatch } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { buildLocalImage } from "../../../../examples/local/runtime";
import { qualifySessionTemplate } from "../../../../examples/local/session-template";
import { createInstances } from "./instances";
import { createManagedHarness } from "./managed-agent";
import { managedBindings } from "./managed-bindings";
import { createOpenManagedSessions } from "./managed-sessions";

const repo = resolve(import.meta.dir, "../../../..");
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(stderr);
};

async function repairProfile(
  instances: ReturnType<typeof createInstances>,
  instanceId: string,
  profile: string,
  template: { metadata: { name: string }; spec: { version: string } },
  sessionId: string,
  ask: (expected: "completed" | "disconnected") => Promise<void>,
) {
  const client = await instances.client(instanceId);
  await instances.configureManagedProfile(instanceId, profile, template.metadata.name, "9.9.9");
  for (const workspace of await instances.items<{ id: string }>(instanceId, "/v1/workspaces").catch(() => []))
    await client.workspaces.cancel(workspace.id);
  const answer = ask("disconnected");
  // The harness keeps the accepted request while the controller waits for a usable profile.
  const deadline = Date.now() + 30000;
  while ((await client.sessions.get(sessionId)).reasonCode !== "template_unavailable") {
    if (Date.now() >= deadline) throw new Error("Missing template suspension was not reported");
    await Bun.sleep(100);
  }
  expect(await client.profiles.get(profile)).toMatchObject({ templateVersion: "9.9.9", disabled: true });
  const pending = (await client.sessions.conversation(sessionId)).requests.filter((r) => r.state !== "terminal");
  expect(pending).toHaveLength(1);
  const [waiting] = pending;
  if (!waiting) throw new Error("Missing pending request");
  await instances.stop(instanceId);
  await answer;
  await instances.start(instanceId);
  const restarted = await instances.client(instanceId);
  expect(await restarted.sessions.get(sessionId)).toMatchObject({
    state: "suspended",
    reasonCode: "template_unavailable",
  });
  await instances.configureManagedProfile(instanceId, profile, template.metadata.name, template.spec.version);
  await ask("completed");
  expect(await restarted.requests.get(sessionId, waiting.requestId)).toMatchObject({
    state: "terminal",
    outcome: "completed",
  });
  expect((await restarted.sessions.conversation(sessionId)).requests).toHaveLength(3);
  expect(await restarted.sessions.get(sessionId)).toMatchObject({ state: "ready", reasonCode: null });
  expect(
    (await instances.items<{ state: string }>(instanceId, "/v1/workspaces")).filter((w) => w.state === "ready"),
  ).toHaveLength(1);
}

test("managed Lab sessions share one machine and keep running when a sibling closes", async () => {
  await command([
    "bun",
    "build",
    "packages/supervisor/src/index.ts",
    "--target",
    "bun",
    "--outdir",
    "deploy/image/dist",
  ]);
  const imageTag = `pocketcoder-pstdio-echo:managed-${randomUUID()}`;
  const { imageId } = await buildLocalImage({ root: repo, imageTag, context: "deploy/image" });
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-managed-lab-"));
  const instances = createInstances(join(root, "instances"));
  const bindings = (projectId: string) => managedBindings(projectId, join(root, "bindings"));
  await mkdir(join(root, "bindings", "test"), { recursive: true });
  const created: string[] = [];
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "test",
    overrides: {
      extensionId: "pocketcoder.pocketcoder",
      sessions: {
        create: async (input: { title: string }) => {
          const id = randomUUID();
          created.push(id);
          return { id, title: input.title };
        },
      } as never,
    },
  });
  const state = createMemoryStorage();
  const harnessCtx = {
    ...ctx,
    logger: console,
    state: {
      get: <T>(key: string) => state.get<T>(key),
      set: (key: string, value: unknown) => state.set(key, value),
      delete: (key: string) => state.delete(key),
    },
  };
  const harness = createManagedHarness(() => instances, bindings);
  let instanceId: string | undefined;
  try {
    const template = await qualifySessionTemplate(
      JSON.parse(await readFile(join(repo, "examples/harnesses/echo/template.json"), "utf8")),
      `${imageTag}@${imageId}`,
    );
    await writeFile(join(root, "echo.json"), JSON.stringify(template));
    const instance = await instances.launch({
      name: "Managed sessions",
      manifest: template,
      binary: join(repo, "out/native/pocketcoder"),
    });
    instanceId = instance.id;
    const open = createOpenManagedSessions(() => instances, bindings);
    const opened = await open.run(ctx, {
      instance: instance.id,
      template: `${template.metadata.name}@${template.spec.version}`,
      count: 2,
    });
    expect(opened.sessions).toHaveLength(2);

    const ask = async (sessionId: string, prompt: string, expected: "completed" | "disconnected" = "completed") => {
      const patches: JsonPatch[] = [];
      const events: HarnessEventSink = { push: (patch) => void patches.push(patch), getMessages: () => [] };
      const run = await harness.start(harnessCtx, { sessionId, prompt, events });
      expect(await run.done).toEqual({ status: expected });
      if (expected === "completed") expect(JSON.stringify(patches)).toContain(`echo: ${prompt}`);
    };
    const [first, second] = opened.sessions;
    if (!first || !second) throw new Error("Missing managed sessions");
    await ask(first.sessionId, "hello from the first chat");
    await ask(second.sessionId, "hello from the second chat");
    const live = async () =>
      (await instances.items<{ state: string }>(instance.id, "/v1/workspaces")).filter((m) => m.state === "ready");
    expect(await live()).toHaveLength(1);

    const client = await instances.client(instance.id);
    await client.sessions.close(first.managedSessionId);
    await ask(second.sessionId, "still answering");
    expect(await live()).toHaveLength(1);
    await repairProfile(instances, instance.id, opened.profile, template, second.managedSessionId, (expected) =>
      ask(second.sessionId, "answer after profile repair", expected),
    );
  } finally {
    if (instanceId) {
      const client = await instances.client(instanceId);
      for (const machine of await instances.items<{ id: string }>(instanceId, "/v1/workspaces").catch(() => []))
        await client.workspaces.cancel(machine.id).catch(() => {});
      await instances.stop(instanceId).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
    await command(["docker", "image", "rm", "-f", imageTag]).catch(() => {});
  }
}, 300_000);
