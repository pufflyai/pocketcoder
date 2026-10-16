import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationRequestIdentity } from "@pstdio/pocketcoder-contracts";
import { ExecutionDispatcher } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

async function conversationFixture(weak = false) {
  const f = await executionFixture(serviceExecutionTemplate, weak ? { capabilities: ["unknown-outcome"] } : {});
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
  const f = await conversationFixture(true);
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
    await dispatcher.tick();
    await dispatcher.tick();
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
    await f.store.inputs.finalize(input.execution.requestId, new Date());
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
