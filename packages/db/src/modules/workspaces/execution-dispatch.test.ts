import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { ExecutionDispatcher } from "@pstdio/pocketcoder-runtime-core";
import { DatabaseStore } from "../../store";
import { executionFixture } from "./execution-fixture.test";

test.each([1, 5, 20])(
  "%s concurrent submissions keep one acceptance and cancel before claim never dispatches",
  async (concurrency) => {
    const f = await executionFixture();
    try {
      const input = f.acceptance();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => f.store.executions.accept(input, new Date())),
      );
      expect(results.filter((r) => r.kind === "accepted")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "replayed")).toHaveLength(concurrency - 1);
      const { fingerprint: _, ...changed } = { ...input, bindingSetDigest: digestOf(["different"]) };
      await expect(
        f.store.executions.accept({ ...changed, fingerprint: digestOf(changed) }, new Date()),
      ).rejects.toThrow("fingerprint");
      const cancel = { execution: input.execution, cancelId: randomUUID(), scope: "operation" as const };
      expect((await f.store.executions.cancel(cancel, new Date())).phase).toBe("canceled");
      expect((await f.store.inputs.getManifest(executionInputManifestId(input)))?.finalizedAt).toBeInstanceOf(Date);
      expect(await f.store.executions.claim(input.execution, new Date())).toBeNull();
    } finally {
      await f.dispose();
    }
  },
);

test("dispatch claim persists before send and loss never replays to another incarnation", async () => {
  const f = await executionFixture();
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date());
    expect((await f.store.executions.claim(input.execution, new Date()))?.first).toBe(true);
    expect((await f.store.executions.claim(input.execution, new Date()))?.first).toBe(false);
    await f.store.endWorkspaceRuntime(f.id, input.execution.incarnationId, new Date());
    expect(await f.store.executions.claim(input.execution, new Date())).toBeNull();
    expect((await f.store.executions.get(input.execution))?.phase).toBe("lost");
    await expect(f.store.executions.accept(f.acceptance(), new Date())).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("accepted and canceled intent and finalized input receipts survive controller restart", async () => {
  const f = await executionFixture(undefined, { mode: "disk" });
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date());
    await f.store.executions.cancel(
      { execution: input.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    await f.store.close();
    const reopened = await DatabaseStore.openPGlite(f.directory);
    try {
      expect((await reopened.executions.get(input.execution))?.phase).toBe("canceled");
      expect((await reopened.inputs.getManifest(executionInputManifestId(input)))?.manifest).toEqual(input.inputs);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test("an unavailable producer cannot starve another accepted workspace", async () => {
  const f = await executionFixture();
  const other = await executionFixture(undefined, { base: f });
  const first = f.acceptance();
  const second = other.acceptance();
  const producer = Bun.serve({
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { execution: { workspaceId: string } };
      return Response.json({ completed: true }, { status: input.execution.workspaceId === f.id ? 503 : 200 });
    },
  });
  try {
    await f.store.executions.accept(first, new Date());
    await f.store.executions.accept(second, new Date());
    let failed = false;
    const dispatcher = new ExecutionDispatcher({
      onHealth: (value) => {
        failed = value;
      },
      store: f.store,
      concurrency: 1,
      inspect: async () => ({ exists: true, running: true, containerIdentity: f.runtime.incarnationId }),
      transport: {
        connected: () => true,
        async accept(record) {
          const response = await fetch(`http://localhost:${producer.port}`, {
            method: "POST",
            body: JSON.stringify(record.acceptance),
          });
          if (!response.ok) throw new Error("Producer unavailable");
          await f.store.executions.observe(
            record.acceptance.execution,
            record.acceptance.fingerprint,
            "terminal",
            1,
            new Date(),
            await response.json(),
          );
        },
        async lookup() {
          return undefined;
        },
        async cancel() {
          throw new Error("Cancellation was not requested");
        },
        async acknowledge(record) {
          await f.store.executions.acknowledge(record.acceptance.execution, record.acceptance.fingerprint, new Date());
        },
      },
    });
    await dispatcher.tick();
    await dispatcher.drain();
    expect(failed).toBe(true);
    expect((await f.store.executions.get(first.execution))?.phase).toBe("dispatching");
    expect((await f.store.executions.get(second.execution))?.phase).toBe("terminal");
  } finally {
    await producer.stop(true);
    await f.dispose();
  }
});
