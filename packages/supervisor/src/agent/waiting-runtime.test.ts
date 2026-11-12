import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type FiniteProcessFact,
  FiniteProcessFactSchema,
  PROTOCOL_VERSION,
  ProviderInputSchema,
  parseWorkloadTemplate,
  ServerFrameSchema,
  ServiceSchema,
  waitingExecSpec,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { WaitingRuntime } from "./waiting-runtime";

async function fixture(
  code: number,
  operation = "run",
  configure?: (source: import("@pstdio/pocketcoder-contracts").WorkloadTemplate) => void,
  launchInput?: Record<string, unknown>,
) {
  const workspaceId = randomUUID();
  const source = await Bun.file(resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json")).json();
  source.spec.network = { mode: "unrestricted" };
  source.spec.adapters.main.command = [process.execPath, "-e", `process.exit(${code})`];
  source.spec.operations = { [operation]: source.spec.operations.run };
  configure?.(source);
  const exec = waitingExecSpec(workloadSnapshotOf(parseWorkloadTemplate(source)), "container", "create");
  const facts: FiniteProcessFact[] = [];
  const runtime = new WaitingRuntime(
    ProviderInputSchema.parse({
      workspace_id: workspaceId,
      server_url: "http://127.0.0.1",
      registration_secret: "single-use-fixture",
      template_digest: `sha256:${"a".repeat(64)}`,
      launch_input: launchInput,
    }),
    exec,
    (type, payload) => {
      if (type === "finite_process") facts.push(FiniteProcessFactSchema.parse(payload));
      return true;
    },
    {
      async pump(stream) {
        if (!stream) return;
        for await (const _chunk of stream) {
          // Drain real process output without retaining it.
        }
      },
      log() {},
    },
  );
  const start = (name: string) =>
    ServerFrameSchema.parse({
      v: PROTOCOL_VERSION,
      workspace_id: workspaceId,
      connection_id: randomUUID(),
      seq: 1,
      sent_at: new Date().toISOString(),
      type: "process_start",
      payload: {
        execution: { workspaceId, incarnationId: "container", owner: "process", requestId: randomUUID() },
        fingerprint: `sha256:${"a".repeat(64)}`,
        operation: name,
      },
    });
  return { runtime, facts, start };
}

test.each(["constructor", "toString"])(
  "undeclared operation %s cannot consume the finite process claim",
  async (name) => {
    const { runtime, facts, start } = await fixture(0);
    try {
      expect(() => runtime.handle(start(name), true)).toThrow("Unsupported finite operation");
      expect(facts).toEqual([]);
      runtime.handle(start("run"), true);
      await runtime.process.drained;
      expect(facts.at(-1)).toMatchObject({ phase: "exited", exitCode: 0, signal: null });
    } finally {
      await runtime.close();
    }
  },
);

test("an explicitly declared constructor operation runs its command", async () => {
  const { runtime, facts, start } = await fixture(7, "constructor");
  try {
    runtime.handle(start("constructor"), true);
    await runtime.process.drained;
    expect(facts.at(-1)).toMatchObject({ phase: "exited", exitCode: 7, signal: null });
  } finally {
    await runtime.close();
  }
});

test.each([false, true])("declared websites survive operation completion or targeted cancel (%s)", async (cancel) => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  const f = await fixture(
    0,
    "run",
    (source) => {
      const adapter = source.spec.adapters.main;
      if (cancel && adapter) adapter.command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
      source.spec.services.web = {
        ...ServiceSchema.parse({
          baseUrl: `http://127.0.0.1:${port}`,
          healthPath: "/",
          routes: [{ method: "GET", path: "/" }],
          required: false,
        }),
        autostart: true,
        process: {
          command: [
            process.execPath,
            "-e",
            `Bun.serve({port:${port},fetch:()=>new Response(process.env.POCKETCODER_LAUNCH_INPUT??'missing')});`,
          ],
          env: {},
        },
      };
    },
    { code: "workspace-scoped" },
  );
  const live = () =>
    fetch(`http://127.0.0.1:${port}`).then(
      async (r) => (await r.text()) === JSON.stringify({ code: "workspace-scoped" }),
      () => false,
    );
  try {
    expect(f.facts).toEqual([]);
    await f.runtime.startInfrastructure();
    const deadline = Date.now() + 2000;
    while (!(await live()) && Date.now() < deadline) await Bun.sleep(10);
    expect(await live()).toBe(true);
    const frame = f.start("run");
    f.runtime.handle(frame, true);
    if (frame.type !== "process_start") throw new Error("Missing start frame");
    if (cancel)
      f.runtime.handle(
        ServerFrameSchema.parse({
          ...frame,
          type: "process_cancel",
          payload: {
            execution: frame.payload.execution,
            cancelId: randomUUID(),
            signal: "SIGKILL",
            deadlineAt: new Date(Date.now() + 1000).toISOString(),
          },
        }),
        true,
      );
    await f.runtime.process.drained;
    expect(f.facts.at(-1)?.phase).toBe("exited");
    expect(await live()).toBe(true);
    f.runtime.reconnect();
    expect(await live()).toBe(true);
    await f.runtime.close();
    expect(await live()).toBe(false);
  } finally {
    await f.runtime.close();
  }
});
