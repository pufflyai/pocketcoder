import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createMachineHarness } from "./agent";
import { createInstances } from "./instances";
import { createMachineCommands } from "./machine-commands";
import { createMachineLifecycleActions } from "./machine-lifecycle-actions";
import { type ControllerMachine, isTerminal, machinePath } from "./machines";

const repo = resolve(import.meta.dir, "../../../..");
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(stderr);
  return stdout.trim();
}

test("relaunch starts fresh; resume restores a real checkpoint with fresh launch input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-lifecycle-"));
  const image = `pocketcoder-lifecycle:test-${randomUUID()}`;
  const instances = createInstances(root);
  const actions = createMachineLifecycleActions(() => instances);
  const machines = createMachineCommands(() => instances);
  const harness = createMachineHarness(() => instances);
  const ctx = {
    ...makeCommandContext({
      params: {},
      projectId: randomUUID(),
      storage: createMemoryStorage(),
      overrides: { extensionId: "pocketcoder.pocketcoder" },
    }),
    state: createMemoryStorage(),
  };
  let instanceId = "";
  const machineIds: string[] = [];
  const ready = async (id: string) => {
    let machine = await instances.request<ControllerMachine>(instanceId, machinePath(id));
    while (machine.state !== "ready" && !isTerminal(machine)) {
      const change = await instances.request<{ workspace: ControllerMachine }>(
        instanceId,
        `${machinePath(id)}/changes?after=${machine.change_cursor}&wait=30`,
      );
      machine = change.workspace;
    }
    expect(machine.state).toBe("ready");
    return machine;
  };
  const turn = async (id: string, prompt: string) => {
    const sessionId = randomUUID();
    await instances.bindSession(sessionId, instanceId, id);
    const session = await harness.start(ctx, {
      sessionId,
      prompt,
      events: { push() {}, getMessages: () => [] },
    });
    expect(await session.done).toEqual({ status: "completed" });
    return session;
  };
  try {
    await command([
      "bun",
      "build",
      "packages/supervisor/src/index.ts",
      "--target",
      "bun",
      "--outdir",
      "deploy/image/dist",
    ]);
    await command(["docker", "build", "-t", image, "deploy/image"]);
    const digest = await command(["docker", "image", "inspect", image, "--format", "{{.Id}}"]);
    const manifest = await Bun.file(join(repo, "examples/templates/persistent-echo.json")).json();
    manifest.spec.image = `${image}@${digest}`;
    manifest.spec.harness.command = [
      "bun",
      "-e",
      `
      const input = JSON.parse(process.env.POCKETCODER_LAUNCH_INPUT);
      if (!input.bootstrap_code) throw new Error("Fresh bootstrap required");
      await Bun.write('/tmp/bootstrap-proof', input.bootstrap_code);
      await import('/opt/pocketcoder/echo-harness.ts');
    `,
    ];
    const instance = await instances.launch({
      name: "lifecycle",
      binary: join(repo, "out/native/pocketcoder"),
      manifest,
    });
    instanceId = instance.id;
    const source = await machines.launchMachine.run(ctx, {
      instance: instanceId,
      template: "persistent-echo@1.0.0",
      externalId: "original-task",
      connection: "agentapi",
      launchInput: JSON.stringify({ bootstrap_code: "original-bootstrap" }),
      metadata: JSON.stringify({
        application: "old-task",
        "pstdio.device_id": "old-device",
        "pstdio.workspace_id": "old-workspace",
      }),
    });
    machineIds.push(source.machineId);
    await ready(source.machineId);
    await expect(actions.resume.run(ctx, { machineId: `${instanceId}:${source.machineId}` })).rejects.toThrow(
      "No ready checkpoint",
    );
    expect((await instances.items(instanceId, "/v1/workspaces")).length).toBe(1);
    await turn(source.machineId, "saved conversation");
    await command([
      "docker",
      "exec",
      `pocketcoder-ws-${source.machineId}`,
      "bun",
      "-e",
      "await Bun.write('/workspace/saved.txt', 'saved files');",
    ]);

    const relaunched = await actions.relaunch.run(ctx, {
      machineId: `${instanceId}:${source.machineId}`,
      launchInput: JSON.stringify({ bootstrap_code: "relaunch-bootstrap" }),
    });
    machineIds.push(relaunched.machineId);
    const fresh = await ready(relaunched.machineId);
    expect(fresh.id).not.toBe(source.machineId);
    expect(fresh.external_id).not.toBe("original-task");
    expect(fresh.metadata).toEqual({ "pstdio.connection": "agentapi" });
    expect(fresh.template.name).toBe("persistent-echo");
    expect(fresh.template.version).toBe("1.0.0");
    expect((await instances.request<ControllerMachine>(instanceId, machinePath(source.machineId))).state).toBe("ready");
    expect(await command(["docker", "exec", `pocketcoder-ws-${fresh.id}`, "cat", "/tmp/bootstrap-proof"])).toBe(
      "relaunch-bootstrap",
    );
    expect(
      await command([
        "docker",
        "exec",
        `pocketcoder-ws-${fresh.id}`,
        "sh",
        "-c",
        "test ! -f /workspace/saved.txt && test ! -f /state/messages.json",
      ]),
    ).toBe("");

    await instances.request(instanceId, `${machinePath(source.machineId)}/preserve`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    let preserved = await instances.request<ControllerMachine>(instanceId, machinePath(source.machineId));
    while (!isTerminal(preserved)) {
      const change = await instances.request<{ workspace: ControllerMachine }>(
        instanceId,
        `${machinePath(source.machineId)}/changes?after=${preserved.change_cursor}&wait=30`,
      );
      preserved = change.workspace;
    }
    expect(preserved.state).toBe("preserved");
    const resumed = await actions.resume.run(ctx, {
      machineId: `${instanceId}:${source.machineId}`,
      externalId: "resumed-task",
      launchInput: JSON.stringify({ bootstrap_code: "resume-bootstrap" }),
      metadata: JSON.stringify({ application: "new-task" }),
    });
    machineIds.push(resumed.machineId);
    const restored = await ready(resumed.machineId);
    expect(restored.id).not.toBe(source.machineId);
    expect(restored.external_id).toBe("resumed-task");
    expect(restored.metadata).toEqual({ application: "new-task", "pstdio.connection": "agentapi" });
    expect(await command(["docker", "exec", `pocketcoder-ws-${restored.id}`, "cat", "/tmp/bootstrap-proof"])).toBe(
      "resume-bootstrap",
    );
    expect(await command(["docker", "exec", `pocketcoder-ws-${restored.id}`, "cat", "/workspace/saved.txt"])).toBe(
      "saved files",
    );
    const result = await turn(restored.id, "continued conversation");
    const history = JSON.stringify(await harness.getMessages(ctx, { agentSessionId: result.agentSessionId ?? "" }));
    expect(history).toContain("saved conversation");
    expect(history).toContain("continued conversation");
    expect((await instances.request<ControllerMachine>(instanceId, machinePath(source.machineId))).state).toBe(
      "preserved",
    );
  } finally {
    await harness.dispose(ctx);
    if (instanceId) {
      for (const machineId of machineIds) await machines.deleteMachine.run(ctx, { instance: instanceId, machineId });
      await instances.stop(instanceId);
    }
    await rm(root, { recursive: true, force: true });
    await command(["docker", "image", "rm", image]);
  }
}, 180_000);
