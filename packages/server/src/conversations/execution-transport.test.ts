import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProducerCancelSchema, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";

test("lost service terminal acknowledgment retries the same acknowledgement after the producer forgets its receipt", async () => {
  let acceptance: WorkloadAcceptance | null = null;
  let accepts = 0;
  let acknowledgments = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
      const body = (await request.json()) as { acceptance?: WorkloadAcceptance };
      const path = new URL(request.url).pathname;
      if (path === "/executions/ack") {
        acknowledgments++;
        return new Response("", { status: acknowledgments === 1 ? 503 : 200 });
      }
      if (path === "/executions/accept") {
        accepts++;
        acceptance = body.acceptance ?? null;
      }
      if (!acceptance) throw new Error("Producer has no accepted request");
      if (acknowledgments) return Response.json({ execution: acceptance.execution, phase: "absent" });
      return Response.json({
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        phase: "terminal",
        outcome: { completed: true },
      });
    },
  });
  const f = await serviceFixture(Number(producer.url.port));
  try {
    const input = f.acceptance();
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: f.id,
      request_id: input.execution.requestId,
      turn_id: randomUUID(),
      request_fingerprint: "a".repeat(64),
    };
    await f.store.executions.accept(input, new Date(), identity);
    await expect(f.dispatcher.tick()).rejects.toThrow("reconciliation");
    expect((await f.store.executions.get(input.execution))?.phase).toBe("terminal");
    expect((await f.store.executions.get(input.execution))?.acknowledgedAt).toBeNull();
    await f.dispatcher.tick();
    expect(acknowledgments).toBe(2);
    expect(accepts).toBe(1);
    expect((await f.store.executions.get(input.execution))?.acknowledgedAt).toBeString();
    await f.store.executions.finalize(input.execution, new Date());
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

function serviceFixture(port: number) {
  return processDispatchFixture((source) => {
    source.spec.profile = "service";
    const adapter = source.spec.adapters.main;
    if (!adapter) throw new Error("Adapter missing");
    adapter.kind = "service";
    adapter.protocol = "pocketcoder.execution/v1";
    adapter.service = "agent";
    delete adapter.command;
    source.spec.services = {
      agent: {
        baseUrl: `http://127.0.0.1:${port}`,
        required: false,
        healthPath: "/status",
        routes: ["accept", "lookup", "cancel", "ack"].map((action) => ({
          method: "POST",
          path: `/executions/${action}`,
          query: [],
          responseMode: "buffered",
          maxRequestBytes: 65536,
          maxResponseBytes: 65536,
          deadlineSeconds: 1,
        })),
      },
    };
  });
}

test("a service can cancel a dispatch that was never accepted using the frozen fingerprint", async () => {
  let accepts = 0;
  let cancels = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      if (path === "/executions/accept") {
        accepts++;
        return new Response(null, { status: 503 });
      }
      if (path === "/executions/ack") return new Response(null, { status: 200 });
      const cancel = ProducerCancelSchema.parse(await request.json());
      cancels++;
      return Response.json({
        execution: cancel.execution,
        fingerprint: cancel.fingerprint,
        phase: "canceled",
        outcome: { beforeAccept: true },
      });
    },
  });
  const f = await serviceFixture(Number(producer.url.port));
  try {
    const input = f.acceptance();
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: f.id,
      request_id: input.execution.requestId,
      turn_id: randomUUID(),
      request_fingerprint: "a".repeat(64),
    };
    await f.store.executions.accept(input, new Date(), identity);
    await expect(f.dispatcher.tick()).rejects.toThrow("reconciliation");
    await f.store.executions.cancel(
      { execution: input.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    await f.dispatcher.tick();
    expect((await f.store.executions.get(input.execution))?.phase).toBe("canceled");
    expect(accepts).toBe(1);
    expect(cancels).toBe(1);
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});
