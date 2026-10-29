import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProducerCancelSchema, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { MAX_INFLIGHT_RELAY } from "./hub";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

test("service cancel bypasses its held accept and a full relay budget", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let accepts = 0;
  let canceled = false;
  let acknowledgments = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      if (path === "/executions/ack") {
        acknowledgments++;
        return new Response(null, { status: acknowledgments === 1 ? 503 : 200 });
      }
      if (path === "/executions/cancel") {
        const cancel = ProducerCancelSchema.parse(await request.json());
        canceled = true;
        await cancelGate;
        return Response.json({
          execution: cancel.execution,
          fingerprint: cancel.fingerprint,
          phase: "canceled",
          outcome: null,
        });
      }
      const body = (await request.json()) as { acceptance: WorkloadAcceptance };
      accepts++;
      await gate;
      return Response.json({
        execution: body.acceptance.execution,
        fingerprint: body.acceptance.fingerprint,
        phase: canceled ? "canceled" : "running",
        outcome: null,
      });
    },
  });
  const f = await processDispatchFixture(
    (source) => {
      serviceExecutionTemplate(source, Number(producer.url.port));
      const service = source.spec.services.agent;
      if (!service) throw new Error("Service missing");
      for (const route of service.routes) route.deadlineSeconds = 3;
    },
    undefined,
    { concurrency: 1 },
  );
  const relays: Promise<unknown>[] = [];
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date(), executionConversationIdentity(a.execution.requestId));
    await f.dispatcher.tick();
    await f.waitFor(async () => accepts === 1);
    for (let index = 1; index < MAX_INFLIGHT_RELAY; index++)
      relays.push(
        f.hub.relay(f.id, {
          service: "agent",
          method: "POST",
          path: "/executions/accept",
          query: {},
          headers: { "content-type": "application/json" },
          body_b64: Buffer.from(JSON.stringify({ acceptance: a })).toString("base64"),
          deadline_ms: 3000,
        }),
      );
    await f.waitFor(async () => accepts === MAX_INFLIGHT_RELAY);
    const record = await f.store.executions.cancel(
      { execution: a.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    const canceledAt = performance.now();
    f.dispatcher.cancel(record);
    await f.waitFor(async () => canceled);
    expect(f.hub.get(f.id)?.inflight.size).toBe(MAX_INFLIGHT_RELAY + 1);
    const overflow = await f.hub.relayExecutionCancel(f.id, {
      service: "agent",
      method: "POST",
      path: "/executions/cancel",
      query: {},
      headers: {},
      deadline_ms: 3000,
    });
    expect(overflow.error_code).toBe("deadline");
    releaseCancel();
    await f.waitFor(async () => f.dispatchFailed);
    expect((await f.store.executions.get(a.execution))?.acknowledgedAt).toBeNull();
    await f.dispatcher.tick();
    await f.waitFor(async () => Boolean((await f.store.executions.get(a.execution))?.acknowledgedAt));
    expect(performance.now() - canceledAt).toBeLessThan(1000);
    expect(acknowledgments).toBe(2);
    expect(canceled).toBe(true);
    expect((await f.store.executions.get(a.execution))?.phase).toBe("canceled");
    expect((await f.store.executions.get(a.execution))?.acknowledgedAt).toBeString();
  } finally {
    releaseCancel();
    release();
    await Promise.allSettled(relays);
    await f.dispose();
    await producer.stop(true);
  }
});
