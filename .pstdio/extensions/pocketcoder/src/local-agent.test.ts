import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonPatch } from "@pstdio/sdk/extensions";
import { createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { createMachineHarness } from "./agent";
import { createInstances } from "./instances";
import { createLabCommands } from "./lab-commands";
import { createMachineCommands } from "./machine-commands";
import { createMachineProvider, isTerminal, type Machine, machinePath, machineRef } from "./machines";

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

test.each([
  { name: "without bootstrap input", launchInput: "" },
  { name: "with bootstrap input", launchInput: JSON.stringify({ bootstrap_code: "one-use-fixture" }) },
])(
  "local text sessions work $name when the template has no file capability route",
  async ({ launchInput }) => {
    const root = await mkdtemp(join(tmpdir(), "pocketcoder-local-agent-"));
    const image = `pocketcoder-local-agent:test-${randomUUID()}`;
    const instances = createInstances(root);
    const harness = createMachineHarness(() => instances);
    const provider = createMachineProvider(() => instances);
    const ctx = {
      ...makeCommandContext({
        storage: createMemoryStorage(),
        params: {},
        projectId: randomUUID(),
        overrides: { extensionId: "pocketcoder.pocketcoder" },
      }),
      state: createMemoryStorage(),
    };
    let instanceId: string | undefined;
    let machineId: string | undefined;
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
      const manifest = await Bun.file(join(repo, "examples/harnesses/echo/template.json")).json();
      manifest.spec.image = `${image}@${digest}`;
      if (launchInput)
        manifest.spec.harness.command = [
          "bun",
          "-e",
          'if (JSON.parse(process.env.POCKETCODER_LAUNCH_INPUT).bootstrap_code !== "one-use-fixture") throw new Error("Missing bootstrap input"); await import("/opt/pocketcoder/echo-harness.ts");',
        ];
      const instance = await instances.launch({
        name: "local",
        binary: join(repo, "out/native/pocketcoder"),
        manifest,
      });
      instanceId = instance.id;
      const workspaceId = randomUUID();
      const externalId = launchInput ? randomUUID() : workspaceId;
      const created = await provider.create(ctx, {
        projectId: ctx.projectId,
        workspaceId,
        operationId: randomUUID(),
        params: {
          instance: instance.id,
          template: manifest.metadata.name,
          templateVersion: manifest.spec.version,
          launchInput,
          externalId,
          metadata: JSON.stringify({ application: "onefin-fixture" }),
        },
      });
      if (!created.providerRef || created.executionTarget?.kind !== "remote") throw new Error("Missing machine target");
      machineId = machineRef(created.providerRef).machineId;
      expect((await instances.request<{ external_id: string }>(instance.id, machinePath(machineId))).external_id).toBe(
        externalId,
      );
      const workspace = {
        workspaceId,
        executionTarget: created.executionTarget,
      };
      const patches: JsonPatch[] = [];
      const events = { push: (patch: JsonPatch) => patches.push(patch), getMessages: () => [] };
      const sessionId = randomUUID();
      const first = await harness.start(ctx, { workspace, sessionId, prompt: "local check", events });
      expect(await first.done).toEqual({ status: "completed" });
      expect(
        (await instances.request<{ metadata: Record<string, string> }>(instance.id, machinePath(machineId))).metadata,
      ).toEqual({ application: "onefin-fixture" });
      expect(JSON.stringify(patches)).toContain("echo: local check");
      const agentSessionId = first.agentSessionId ?? "";
      const followup = await harness.resume(ctx, { workspace, sessionId, agentSessionId, prompt: "again", events });
      expect(await followup.done).toEqual({ status: "completed" });
      expect(JSON.stringify(await harness.getMessages(ctx, { workspace, agentSessionId }))).toContain("echo: again");
      const lab = createLabCommands(() => instances);
      const snapshot = await lab.read.run(ctx, {});
      expect(snapshot.machines.map((machine) => machine.id)).toContain(machineId);
      const directSession = randomUUID();
      await instances.bindSession(directSession, instanceId, machineId);
      const direct = await harness.start(ctx, {
        sessionId: directSession,
        prompt: "no workspace record",
        events,
      });
      expect(await direct.done).toEqual({ status: "completed" });
      expect(JSON.stringify(await harness.getMessages(ctx, { agentSessionId: direct.agentSessionId ?? "" }))).toContain(
        "echo: no workspace record",
      );
      const commands = createMachineCommands(() => instances);
      await commands.deleteMachine.run(ctx, { instance: instanceId, machineId });
      expect((await lab.read.run(ctx, {})).machines).toEqual([]);
      const keyPath = join(root, instanceId, "owner.json");
      const owner = await readFile(keyPath, "utf8");
      try {
        await writeFile(keyPath, JSON.stringify({ ...JSON.parse(owner), expiresAt: new Date(0).toISOString() }));
        const expired = await lab.read.run(ctx, {});
        expect(expired.instances[0]?.id).toBe(instanceId);
        expect(expired.error).toContain("key expired");
      } finally {
        await writeFile(keyPath, owner);
      }
    } finally {
      await harness.dispose(ctx);
      if (instanceId && machineId) {
        let machine = await instances.request<Machine>(instanceId, `${machinePath(machineId)}/cancel`, {
          method: "POST",
        });
        while (!isTerminal(machine)) {
          const change = await instances.request<{ workspace: Machine }>(
            instanceId,
            `${machinePath(machineId)}/changes?after=${machine.change_cursor}&wait=30`,
          );
          machine = change.workspace;
        }
      }
      if (instanceId) await instances.stop(instanceId);
      await rm(root, { recursive: true, force: true });
      await command(["docker", "image", "rm", image]);
    }
  },
  180_000,
);
