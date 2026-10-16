import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

test.each(["before-send", "after-spawn", "terminal-ack"])(
  "reconciles %s cuts through the real supervisor without a second spawn",
  async (cut) => {
    const f = await processDispatchFixture();
    try {
      const acceptance = f.acceptance();
      await f.store.executions.accept(acceptance, new Date());
      f.dropAccept = cut === "before-send";
      f.dropReplies = cut === "after-spawn";
      f.dropAck = cut === "terminal-ack";
      await f.dispatcher.tick();
      if (cut === "after-spawn") await f.waitFor(async () => f.spawned > 0);
      f.dropAccept = false;
      f.dropReplies = false;
      await f.dispatcher.tick();
      await f.waitFor(async () => (await f.store.executions.get(acceptance.execution))?.phase === "terminal");
      expect((await f.store.getWorkspace(f.id))?.finiteProcess).toMatchObject({
        execution: acceptance.execution,
        exitCode: 7,
      });
      f.dropAck = false;
      await f.dispatcher.tick();
      expect((await f.store.executions.accept(acceptance, new Date())).kind).toBe("replayed");
      expect(f.spawned).toBe(1);
      expect(
        (
          await f.store.executions.cancel(
            { execution: acceptance.execution, cancelId: randomUUID(), scope: "operation" },
            new Date(),
          )
        ).phase,
      ).toBe("terminal");
    } finally {
      await f.dispose();
    }
  },
);

test("cancel after claim but before producer accept records a tombstone and does not spawn", async () => {
  const f = await processDispatchFixture();
  try {
    const acceptance = f.acceptance();
    await f.store.executions.accept(acceptance, new Date());
    f.dropAccept = true;
    await f.dispatcher.tick();
    await f.store.executions.cancel(
      { execution: acceptance.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    f.dropAccept = false;
    await f.dispatcher.tick();
    await f.waitFor(async () => (await f.store.executions.get(acceptance.execution))?.phase === "canceled");
    await f.dispatcher.tick();
    expect(f.spawned).toBe(0);
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("transport reconnect replays the same result and clears a lost terminal acknowledgement", async () => {
  const f = await processDispatchFixture();
  try {
    const acceptance = f.acceptance();
    await f.store.executions.accept(acceptance, new Date());
    f.dropAck = true;
    await f.dispatcher.tick();
    await f.waitFor(async () => (await f.store.executions.get(acceptance.execution))?.phase === "terminal");
    const before = f.received;
    f.dropAck = false;
    f.disconnect();
    await f.waitFor(async () => f.received > before && (f.hub.get(f.id)?.epoch ?? 0) > 1);
    expect(f.spawned).toBe(1);
    expect((await f.store.getWorkspace(f.id))?.finiteProcess?.exitCode).toBe(7);
  } finally {
    await f.dispose();
  }
});
