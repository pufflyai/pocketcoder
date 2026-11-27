import { expect, test } from "bun:test";
import type { WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS, OutboxDispatcher } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { loadConfig } from "../config/config";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";
import { createMaintenance } from "../maintenance/maintenance";
import { Readiness } from "../observability/health";
import { waitFor } from "./admission-hook-fixture";
import { startBackgroundTimers } from "./background-timers";

test("a completed execution finalizes while another workspace launch holds the scheduler", async () => {
  let accepted: WorkloadAcceptance | undefined;
  let completed = false;
  let acknowledged = false;
  const outcome = { status: "completed", finalResponse: "Command exited with 0." };
  const producer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      if (path === "/executions/ack") {
        acknowledged = true;
        return new Response(null, { status: 200 });
      }
      if (path === "/executions/accept")
        accepted = ((await request.json()) as { acceptance: WorkloadAcceptance }).acceptance;
      if (!accepted) throw new Error("Producer has no accepted request");
      return Response.json({
        execution: accepted.execution,
        fingerprint: accepted.fingerprint,
        phase: completed ? "terminal" : "running",
        outcome: completed ? outcome : null,
      });
    },
  });
  const f = await processDispatchFixture((source) => serviceExecutionTemplate(source, producer.port)).catch(
    async (error) => {
      await producer.stop(true);
      throw error;
    },
  );
  const releaseScheduler = Promise.withResolvers<void>();
  const schedulerEntered = Promise.withResolvers<void>();
  let timers: ReturnType<typeof startBackgroundTimers> | undefined;
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date(), executionConversationIdentity(input.execution.requestId, f.id));
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(await f.store.executions.get(input.execution)).toMatchObject({ phase: "running", finalizedAt: null });

    const readiness = new Readiness();
    const built = buildServer({
      store: f.store,
      driver: new DockerDriver(),
      limits: DEFAULT_LIMITS,
      pepper: "fixture",
      workspaceServerUrl: "http://127.0.0.1:0",
      readiness,
    });
    f.scheduler.tick = async () => {
      schedulerEntered.resolve();
      await releaseScheduler.promise;
    };
    timers = startBackgroundTimers({
      ...built,
      scheduler: f.scheduler,
      executionDispatcher: f.dispatcher,
      store: f.store,
      readiness,
      config: loadConfig({ POCKETCODER_SCHEDULER_INTERVAL_MS: "20" }),
      maintenance: createMaintenance(),
      outbox: new OutboxDispatcher({ store: f.store, sinkUrl: null, sign: () => "" }),
      policyReconciliation: undefined,
      log: () => {},
    });
    await schedulerEntered.promise;
    completed = true;
    await waitFor(
      async () => Boolean((await f.store.executions.get(input.execution))?.finalizedAt),
      "the live execution receipt while the scheduler is held",
    );
    expect(await f.store.executions.get(input.execution)).toMatchObject({
      phase: "terminal",
      outcome,
      finalizedAt: expect.any(String),
    });
    expect(acknowledged).toBe(true);
  } finally {
    releaseScheduler.resolve();
    try {
      await timers?.stop();
      await f.dispose();
    } finally {
      await producer.stop(true);
    }
  }
});
