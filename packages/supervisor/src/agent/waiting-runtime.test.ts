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
  waitingExecSpec,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { WaitingRuntime } from "./waiting-runtime";

async function fixture(code: number, operation = "run") {
  const workspaceId = randomUUID();
  const source = await Bun.file(resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json")).json();
  source.spec.network = { mode: "unrestricted" };
  source.spec.adapters.main.command = [process.execPath, "-e", `process.exit(${code})`];
  source.spec.operations = { [operation]: source.spec.operations.run };
  const exec = waitingExecSpec(workloadSnapshotOf(parseWorkloadTemplate(source)), "container", "create");
  const facts: FiniteProcessFact[] = [];
  const runtime = new WaitingRuntime(
    ProviderInputSchema.parse({
      workspace_id: workspaceId,
      server_url: "http://127.0.0.1",
      registration_secret: "single-use-fixture",
      template_digest: `sha256:${"a".repeat(64)}`,
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
