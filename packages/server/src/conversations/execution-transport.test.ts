import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { executionInputManifestId, ProducerCancelSchema, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { eq } from "drizzle-orm";
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
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(f.dispatchFailed).toBe(true);
    expect((await f.store.executions.get(input.execution))?.phase).toBe("terminal");
    expect((await f.store.executions.get(input.execution))?.acknowledgedAt).toBeNull();
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.dispatcher.tick();
    expect(f.dispatchFailed).toBe(false);
    expect(acknowledgments).toBe(2);
    expect(accepts).toBe(1);
    expect((await f.store.executions.get(input.execution))?.acknowledgedAt).toBeString();
    await f.store.executions.finalize(input.execution, new Date());
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

function serviceFixture(port: number, configure?: (source: WorkloadTemplate) => void) {
  return processDispatchFixture((source) => {
    serviceExecutionTemplate(source, port);
    configure?.(source);
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
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(f.dispatchFailed).toBe(true);
    await f.store.executions.cancel(
      { execution: input.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.dispatcher.tick();
    expect(f.dispatchFailed).toBe(false);
    expect((await f.store.executions.get(input.execution))?.phase).toBe("canceled");
    expect(accepts).toBe(1);
    expect(cancels).toBe(1);
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

test("an incomplete service descriptor never reaches producer accept", async () => {
  let accepts = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
      accepts++;
      const { acceptance } = (await request.json()) as { acceptance: WorkloadAcceptance };
      return Response.json({
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        phase: "running",
        outcome: null,
      });
    },
  });
  const f = await serviceFixture(Number(producer.url.port), (source) => {
    const service = source.spec.services.agent;
    if (!service) throw new Error("Fixture service missing");
    service.routes = service.routes.filter((route) => route.path !== "/executions/lookup");
  });
  try {
    const input = f.acceptance();
    await expect(
      f.store.executions.accept(input, new Date(), executionConversationIdentity(input.execution.requestId)),
    ).rejects.toThrow("buffered POST /executions/lookup");
    await f.dispatcher.tick();
    expect(accepts).toBe(0);
    expect(await f.store.executions.get(input.execution)).toBeNull();
    expect(await f.store.inputs.getManifest(executionInputManifestId(input))).toBeNull();
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

test("dispatch failure remains visible until the durable execution becomes lost", async () => {
  const producer = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
      return new Response(null, { status: 503 });
    },
  });
  const f = await serviceFixture(Number(producer.url.port));
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date(), executionConversationIdentity(a.execution.requestId));
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(f.dispatchFailed).toBe(true);
    await f.dispatcher.tick();
    expect(f.dispatchFailed).toBe(true);
    await f.dispatcher.drain();
    await f.store.endWorkspaceRuntime(f.id, a.execution.incarnationId, new Date());
    expect((await f.store.executions.get(a.execution))?.phase).toBe("lost");
    await f.dispatcher.tick();
    expect(f.dispatchFailed).toBe(false);
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

test.each(["terminal", "absent"])("input pin loss keeps service %s lookup safe", async (phase) => {
  let acceptance: WorkloadAcceptance | undefined;
  let accepts = 0,
    acknowledgments = 0;
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      if (path === "/executions/ack") {
        acknowledgments++;
        return new Response(null, { status: 200 });
      }
      if (path === "/executions/accept") {
        accepts++;
        acceptance = ((await request.json()) as { acceptance: WorkloadAcceptance }).acceptance;
      }
      if (!acceptance) throw new Error("Acceptance missing");
      if (path === "/executions/lookup" && phase === "absent")
        return Response.json({ execution: acceptance.execution, phase: "absent" });
      return Response.json({
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        phase: path === "/executions/accept" ? "running" : "terminal",
        outcome: null,
      });
    },
  });
  const f = await serviceFixture(Number(producer.url.port));
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date(), executionConversationIdentity(a.execution.requestId));
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.context.db
      .delete(f.context.tables.inputManifests)
      .where(eq(f.context.tables.inputManifests.id, executionInputManifestId(a)));
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(accepts).toBe(1);
    expect(acknowledgments).toBe(phase === "terminal" ? 1 : 0);
    expect((await f.store.executions.get(a.execution))?.phase).toBe(phase === "terminal" ? "terminal" : "lost");
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});
