import { expect, test } from "bun:test";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { serializeMachineConnection } from "./machine-connection-queue";
import { machineSessionCache } from "./machine-session-cache";

test("overlapping Connect calls create only one cached chat", async () => {
  const cache = machineSessionCache(createMemoryStorage(), "instance", "machine", { kind: "session" });
  let created = 0;
  const connect = () =>
    serializeMachineConnection("project", "instance", "machine", async () => {
      const existing = await cache.get();
      if (existing) return existing;
      const id = `chat-${++created}`;
      await cache.set(id);
      return id;
    });
  expect(await Promise.all([connect(), connect(), connect()])).toEqual(["chat-1", "chat-1", "chat-1"]);
  expect(created).toBe(1);
});

test("a failed connection does not block another machine or a later retry", async () => {
  await expect(
    serializeMachineConnection("project", "instance", "machine", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = serializeMachineConnection("project", "instance", "machine", () => gate);
  try {
    expect(await serializeMachineConnection("project", "instance", "other", async () => "other-chat")).toBe(
      "other-chat",
    );
  } finally {
    release();
    await waiting;
  }
  expect(await serializeMachineConnection("project", "instance", "machine", async () => "retry")).toBe("retry");
});
