import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationRequestIdentity, WorkloadCapability } from "@pstdio/pocketcoder-contracts";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { InputProjectionCapacityError } from "@pstdio/pocketcoder-runtime-contracts";
import { ExecutionDispatcher } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

async function conversationFixture(capabilities?: WorkloadCapability[]) {
  const f = await executionFixture(serviceExecutionTemplate, capabilities ? { capabilities } : {});
  const identity = (requestId: string) => executionConversationIdentity(requestId, f.id);
  return { ...f, identity };
}

test("conversation dispatch preserves request identities and fences late cancel A from next B", async () => {
  const f = await conversationFixture();
  try {
    const a = f.acceptance();
    const identity = f.identity(a.execution.requestId);
    await f.store.acceptConversationRequest(f.id, identity, new Date());
    await f.store.executions.accept(a, new Date(), identity);
    expect((await f.store.executions.accept(a, new Date(), identity)).kind).toBe("replayed");
    await expect(f.store.executions.accept(a, new Date(), { ...identity, turn_id: randomUUID() })).rejects.toThrow(
      "identity conflict",
    );
    await f.store.executions.claim(a.execution, new Date());
    expect(
      await f.store.executions.observe(a.execution, a.fingerprint, "terminal", 0, new Date(), { exit: "ok" }),
    ).toBe(false);
    expect(
      await f.store.executions.observe(a.execution, a.fingerprint, "terminal", 1, new Date(), { exit: "ok" }),
    ).toBe(true);
    expect(
      await f.store.executions.observe(a.execution, a.fingerprint, "terminal", 1, new Date(), { exit: "changed" }),
    ).toBe(false);
    const b = f.acceptance();
    const bIdentity = f.identity(b.execution.requestId);
    await expect(f.store.executions.accept(b, new Date(), bIdentity)).rejects.toThrow("finalization");
    await f.store.executions.acknowledge(a.execution, a.fingerprint, new Date());
    await f.store.executions.finalize(a.execution, new Date());
    expect((await f.store.inputs.getManifest(executionInputManifestId(a)))?.finalizedAt).toBeInstanceOf(Date);
    await f.store.executions.accept(b, new Date(), bIdentity);
    expect(
      (
        await f.store.executions.cancel(
          { execution: a.execution, cancelId: randomUUID(), scope: "operation" },
          new Date(),
        )
      ).phase,
    ).toBe("terminal");
    expect((await f.store.executions.get(b.execution))?.phase).toBe("accepted");
    expect((await f.store.executions.get(a.execution))?.conversationIdentity).toEqual(identity);
    await f.store.endWorkspaceRuntime(f.id, f.runtime.incarnationId, new Date());
    expect((await f.store.executions.get(b.execution))?.phase).toBe("lost");
  } finally {
    await f.dispose();
  }
});

test("weak producer lost response becomes unknown without another request or an unsafe interrupt", async () => {
  const f = await conversationFixture(["unknown-outcome"]);
  let calls = 0;
  const producer = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return new Response(null, { status: 503 });
    },
  });
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date(), f.identity(input.execution.requestId));
    const dispatcher = new ExecutionDispatcher({
      store: f.store,
      inspect: async () => ({ exists: true, running: true, containerIdentity: f.runtime.incarnationId }),
      transport: {
        connected: () => true,
        async accept() {
          await fetch(`http://localhost:${producer.port}`);
        },
        async acknowledge() {
          throw new Error("Weak producer has no terminal receipt");
        },
        async lookup() {
          throw new Error("Weak producer cannot prove absence");
        },
        async cancel() {
          throw new Error("Weak producer cannot target cancellation");
        },
      },
    });
    await dispatcher.tick();
    await dispatcher.drain();
    await dispatcher.tick();
    await dispatcher.drain();
    await dispatcher.tick();
    await dispatcher.drain();
    expect(calls).toBe(1);
    expect((await f.store.executions.get(input.execution))?.phase).toBe("unknown");
    await expect(f.store.executions.finalize(input.execution, new Date())).rejects.toThrow("Unsettled");
  } finally {
    await producer.stop(true);
    await f.dispose();
  }
});

test("purge clears execution input and outcome data while preserving conversation identity receipts", async () => {
  const f = await conversationFixture();
  try {
    const input = f.acceptance();
    const identity = f.identity(input.execution.requestId);
    await f.store.executions.accept(input, new Date(), identity);
    await f.store.executions.claim(input.execution, new Date());
    await f.store.executions.observe(input.execution, input.fingerprint, "terminal", 1, new Date(), {
      privateResult: "delete-me",
    });
    await f.store.executions.acknowledge(input.execution, input.fingerprint, new Date());
    await f.store.executions.finalize(input.execution, new Date());
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(f.context.tables.workspaces.id, f.id));
    await f.store.purgeWorkspaceContent(f.id, new Date());
    expect(await f.store.executions.get(input.execution)).toBeNull();
    const receipts = await f.context.db
      .select()
      .from(f.context.tables.conversationRequests)
      .where(eq(f.context.tables.conversationRequests.requestId, input.execution.requestId));
    expect(receipts[0]?.identity).toEqual(identity);
    expect(receipts[0]?.execution).toBeNull();
    await expect(f.store.executions.accept(input, new Date(), identity)).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test.each(["conversation", "turn", "authority", "fingerprint"])(
  "replay rejects another accepted receipt with changed %s identity",
  async (changed) => {
    const f = await conversationFixture();
    try {
      const input = f.acceptance();
      const original = f.identity(input.execution.requestId);
      await f.store.executions.accept(input, new Date(), original);
      const other: ConversationRequestIdentity = { ...original, conversation_id: randomUUID() };
      if (changed === "turn") other.turn_id = randomUUID();
      if (changed === "authority") other.authority = "generic";
      if (changed === "fingerprint") other.request_fingerprint = "b".repeat(64);
      expect((await f.store.acceptConversationRequest(f.id, other, new Date())).kind).toBe("accepted");
      await expect(f.store.executions.accept(input, new Date(), other)).rejects.toThrow("identity conflict");
      expect((await f.store.executions.accept(input, new Date(), original)).record.conversationIdentity).toEqual(
        original,
      );
    } finally {
      await f.dispose();
    }
  },
);

const parallelCapabilities: WorkloadCapability[] = [
  "parallel-conversations",
  "request-lookup",
  "deduplicated-accept",
  "targeted-cancel",
  "unknown-outcome",
];

test("an adapter that runs conversations in parallel keeps only each conversation to one request", async () => {
  const f = await conversationFixture(parallelCapabilities);
  try {
    const first = f.acceptance();
    const firstIdentity = executionConversationIdentity(first.execution.requestId);
    await f.store.executions.accept(first, new Date(), firstIdentity);
    await f.store.executions.claim(first.execution, new Date());
    // Even an outcome that may still be running holds only its own conversation.
    await f.store.executions.observe(first.execution, first.fingerprint, "unknown", 0, new Date());

    const other = f.acceptance();
    const otherIdentity = executionConversationIdentity(other.execution.requestId);
    expect((await f.store.executions.accept(other, new Date(), otherIdentity)).kind).toBe("accepted");

    const next = f.acceptance();
    const nextIdentity = executionConversationIdentity(next.execution.requestId, firstIdentity.conversation_id);
    await expect(f.store.executions.accept(next, new Date(), nextIdentity)).rejects.toThrow("finalization");
  } finally {
    await f.dispose();
  }
});

test.each([
  { name: "without parallel conversations", capabilities: parallelCapabilities.slice(1) },
  { name: "that cannot look up a request", capabilities: ["parallel-conversations", "unknown-outcome"] },
])("an adapter $name keeps one request per workspace", async ({ capabilities }) => {
  const f = await conversationFixture(capabilities as WorkloadCapability[]);
  try {
    const first = f.acceptance();
    await f.store.executions.accept(first, new Date(), executionConversationIdentity(first.execution.requestId));
    const other = f.acceptance();
    await expect(
      f.store.executions.accept(other, new Date(), executionConversationIdentity(other.execution.requestId)),
    ).rejects.toThrow("finalization");
  } finally {
    await f.dispose();
  }
});

test("a request waiting for input projection capacity is retried without failing controller health", async () => {
  const f = await conversationFixture(parallelCapabilities);
  const health: boolean[] = [];
  let accepts = 0;
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date(), f.identity(input.execution.requestId));
    const dispatcher = new ExecutionDispatcher({
      store: f.store,
      inspect: async () => ({ exists: true, running: true, containerIdentity: f.runtime.incarnationId }),
      onHealth: (failed) => health.push(failed),
      transport: {
        connected: () => true,
        async accept() {
          accepts++;
          if (accepts === 1) throw new InputProjectionCapacityError();
        },
        async acknowledge() {},
        async lookup() {
          return "absent" as const;
        },
        async cancel() {},
      },
    });
    for (let round = 0; round < 3; round++) {
      await dispatcher.tick();
      await dispatcher.drain();
    }
    expect(accepts).toBeGreaterThan(1);
    expect(health).not.toContain(true);
    expect((await f.store.executions.get(input.execution))?.phase).not.toBe("unknown");
  } finally {
    await f.dispose();
  }
});
