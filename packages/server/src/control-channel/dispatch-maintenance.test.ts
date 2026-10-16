import { expect, test } from "bun:test";
import type { WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { createMaintenance } from "../maintenance/maintenance";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

test.each(["maintenance", "shutdown"])("%s drains held dispatch without admitting queued accepts", async (ending) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepts = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
      const { acceptance } = (await request.json()) as { acceptance: WorkloadAcceptance };
      accepts++;
      await gate;
      return Response.json({
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        phase: "running",
        outcome: null,
      });
    },
  });
  const maintenance = createMaintenance();
  const f = await processDispatchFixture(
    (source) => {
      serviceExecutionTemplate(source, Number(producer.url.port));
    },
    undefined,
    { concurrency: 1, canDispatch: () => !maintenance.active },
  );
  const g = await processDispatchFixture((source) => {
    serviceExecutionTemplate(source, Number(producer.url.port));
  }, f);
  let endingTask: Promise<unknown> | undefined;
  try {
    const a = f.acceptance(),
      b = g.acceptance();
    for (const input of [a, b])
      await f.store.executions.accept(input, new Date(), executionConversationIdentity(input.execution.requestId));
    await f.dispatcher.tick();
    await f.waitFor(async () => accepts === 1);
    let settled = false;
    if (ending === "maintenance") {
      maintenance.settleWith(() => f.dispatcher.drain());
      endingTask = maintenance.run(2000, new AbortController().signal, async () => {
        settled = true;
      });
    } else
      endingTask = f.dispatcher.stop().then(() => {
        settled = true;
      });
    await f.dispatcher.absent(a.execution, 1);
    await f.dispatcher.tick();
    await Bun.sleep(40);
    expect(settled).toBe(false);
    expect(accepts).toBe(1);
    release();
    await endingTask;
    expect(settled).toBe(true);
    expect(accepts).toBe(1);
    expect((await f.store.executions.get(b.execution))?.dispatchClaimedAt).toBeNull();
  } finally {
    release();
    await endingTask;
    await g.dispose();
    await f.dispose();
    await producer.stop(true);
  }
});
