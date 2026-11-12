import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessContext, HarnessEventSink, SessionMessage } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createMachineHarness } from "./agent";
import { createInstances } from "./instances";
import { createMachineProvider, machineRef } from "./machines";
import { parseCatalogTemplate } from "./template-catalog";

const repo = resolve(import.meta.dir, "../../../..");
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}

test("a real local agent reads exact uploads, survives a lost reply, follows up and retains history after deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-file-flow-"));
  const manifestPath = join(root, "template.json");
  let imageTag: string | undefined;
  const instances = createInstances(join(root, "instances"));
  let instanceId: string | undefined;
  const provider = createMachineProvider(() => instances);
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "file-flow",
    overrides: { extensionId: "pocketcoder.pocketcoder" },
  });
  ctx.workspaces.addAnchors = async () => {};
  let ref: Awaited<ReturnType<typeof provider.create>>["providerRef"] | undefined;
  const operation = {
    operationId: randomUUID(),
    projectId: "file-flow",
    workspaceId: randomUUID(),
    params: {} as Record<string, string>,
  };
  try {
    const built = JSON.parse(await command([process.execPath, "scripts/pstdio-demo.ts", "--output", manifestPath]));
    imageTag = built.imageTag;
    const manifest = parseCatalogTemplate(manifestPath, await Bun.file(manifestPath).text()).manifest;
    const instance = await instances.launch({
      name: "File flow",
      binary: join(repo, "out/native/pocketcoder"),
      manifests: [manifest],
    });
    instanceId = instance.id;
    operation.params = { instance: instance.id, template: "file-agent", templateVersion: "1.0.0" };
    const created = await provider.create(ctx, operation);
    ref = created.providerRef;
    if (!ref) throw new Error("No workspace reference");
    let workspace = await provider.resolve(ctx, { ...operation, providerRef: ref });
    const deadline = Date.now() + 30000;
    while (workspace.state === "provisioning" && Date.now() < deadline) {
      await Bun.sleep(100);
      workspace = await provider.resolve(ctx, { ...operation, providerRef: ref });
    }
    expect(workspace.state).toBe("ready");
    if (workspace.executionTarget?.kind !== "remote") throw new Error("No execution target");
    const signal = AbortSignal.timeout(45000);
    const target = { workspaceId: operation.workspaceId, executionTarget: workspace.executionTarget };
    const state = new Map<string, unknown>();
    const context: HarnessContext = {
      ...ctx,
      name: "pocketcoder",
      logger: console,
      state: {
        async get<T>(key: string) {
          return state.get(key) as T | undefined;
        },
        async set(key, value) {
          state.set(key, value);
        },
        async delete(key) {
          state.delete(key);
        },
      },
    };
    let messages: readonly SessionMessage[] = [];
    const events: HarnessEventSink = {
      getMessages: () => messages,
      push(patch) {
        if (patch.path === "/messages") messages = patch.value as SessionMessage[];
      },
    };
    const sessionId = randomUUID();
    const harness = createMachineHarness(() => instances);
    expect(await harness.capabilities()).toContain("Attachments");
    const connected = await harness.start(context, { sessionId, workspace: target, prompt: "", events });
    expect(await connected.done).toEqual({ status: "completed" });
    const rejected = await harness.resume(context, {
      sessionId,
      signal,
      workspace: target,
      agentSessionId: connected.agentSessionId ?? "",
      prompt: "x".repeat(262145),
      events,
    });
    expect(await rejected.done).toEqual({ status: "failed" });
    expect(state.has(`file-turn:${sessionId}`)).toBe(false);
    const file = join(root, "loan facts.txt");
    const content = "Loan principal: SEK 1250000\nCustomer: Åsa";
    await Bun.write(file, content);
    const attachment = {
      fileId: randomUUID(),
      fileName: "loan facts.txt",
      mimeType: "text/plain",
      sizeBytes: Bun.file(file).size,
      localPath: file,
      url: "http://localhost/host-file",
    };
    let dropped = false;
    const lossy = createMachineHarness(() => ({
      ...instances,
      async request<T>(id: string, path: string, input?: RequestInit): Promise<T> {
        const response = await instances.request<T>(id, path, input);
        if (!dropped && input?.method === "POST" && path.endsWith("/requests")) {
          dropped = true;
          throw new Error("Lost submit response");
        }
        return response;
      },
    }));
    const first = await lossy.resume(context, {
      sessionId,
      signal,
      workspace: target,
      agentSessionId: connected.agentSessionId ?? "",
      prompt: "Read the loan",
      attachments: [attachment],
      events,
    });
    expect(await first.done).toEqual({ status: "disconnected" });
    expect(dropped).toBe(true);
    const reconnected = await createMachineHarness(() => instances).reattach(context, {
      sessionId,
      signal,
      workspace: target,
      agentSessionId: first.agentSessionId ?? "",
      events,
    });
    expect(await reconnected.done).toEqual({ status: "completed" });
    expect(JSON.stringify(messages)).toContain("Loan principal: SEK 1250000");
    expect(JSON.stringify(messages)).toContain("Åsa");
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    const next = await harness.resume(context, {
      sessionId,
      signal,
      workspace: target,
      agentSessionId: reconnected.agentSessionId ?? "",
      prompt: "follow up",
      events,
    });
    expect(await next.done).toEqual({ status: "completed" });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("echo: follow up");
    await Bun.write(file, "Changed immutable bytes");
    await expect(
      harness.resume(context, {
        sessionId,
        signal,
        workspace: target,
        agentSessionId: next.agentSessionId ?? "",
        prompt: "Changed upload",
        attachments: [{ ...attachment, sizeBytes: Bun.file(file).size }],
        events,
      }),
    ).rejects.toThrow("409");
    await provider.delete(ctx, { ...operation, providerRef: ref });
    expect((await provider.resolve(ctx, { ...operation, providerRef: ref })).state).toBe("cancelled");
    state.clear();
    const retained = await harness.getMessages(context, {
      workspace: target,
      agentSessionId: next.agentSessionId ?? "",
    });
    expect(retained.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(JSON.stringify(retained)).toContain("Loan principal: SEK 1250000");
    console.log(
      JSON.stringify({
        ticket: "PC-178",
        workspaceId: machineRef(ref).machineId,
        image: built.image,
        exactBytes: content,
        lostResponseReplayed: true,
        completedTurns: 2,
      }),
    );
    ref = undefined;
  } finally {
    if (ref) await provider.delete(ctx, { ...operation, providerRef: ref });
    if (instanceId) await instances.stop(instanceId);
    if (imageTag) await command(["docker", "image", "rm", imageTag]);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
