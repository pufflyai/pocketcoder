import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { FiniteProcess } from "./finite-process";

test("cancel before accept leaves a tombstone and a stale cancel cannot signal another request", async () => {
  const execution = {
    workspaceId: randomUUID(),
    incarnationId: "container",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  const runtime = new FiniteProcess(execution.workspaceId, execution.incarnationId, () => {});
  const cancelId = randomUUID();
  expect(runtime.cancelOperation(execution, cancelId)).toBe("canceled");
  expect(
    runtime.start(execution, `sha256:${"a".repeat(64)}`, { command: ["/bin/sh", "-c", "exit 7"], env: {} }),
  ).toBeNull();
  const next = { ...execution, requestId: randomUUID() };
  runtime.start(next, `sha256:${"b".repeat(64)}`, { command: ["/bin/sh", "-c", "sleep 0.1; exit 9"], env: {} });
  expect(runtime.cancelOperation(execution, cancelId)).toBe("canceled");
  expect(runtime.lookup(next)?.phase).toBe("running");
  await runtime.drained;
  expect(runtime.lookup(next)?.exitCode).toBe(9);
  expect(runtime.cancelOperation(next, randomUUID())).toBe("terminal");
});

test("the same cancel identity can escalate to KILL when an owned process ignores TERM", async () => {
  const execution = {
    workspaceId: randomUUID(),
    incarnationId: "container",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  let ready: (() => void) | undefined;
  const prepared = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const process = new FiniteProcess(
    execution.workspaceId,
    execution.incarnationId,
    () => {},
    async (stream) => {
      for await (const chunk of stream) {
        if (new TextDecoder().decode(chunk).includes("ready")) ready?.();
      }
    },
  );
  process.start(execution, `sha256:${"a".repeat(64)}`, {
    command: ["/bin/sh", "-c", "trap '' TERM; printf ready; while :; do sleep 1; done"],
    env: {},
  });
  try {
    await prepared;
    const cancelId = randomUUID();
    expect(process.cancelOperation(execution, cancelId, "SIGTERM")).toBe("requested");
    expect(process.lookup(execution)?.phase).toBe("running");
    expect(process.cancelOperation(execution, cancelId, "SIGKILL")).toBe("requested");
    await process.drained;
    expect(process.lookup(execution)?.signal).toBe("SIGKILL");
  } finally {
    await process.stopWriters("SIGKILL");
  }
});
