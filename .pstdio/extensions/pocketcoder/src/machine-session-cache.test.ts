import { expect, test } from "bun:test";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { machineSessionCache } from "./machine-session-cache";

test("cached sessions belong to one machine and connection target", async () => {
  const storage = createMemoryStorage();
  const relay = { kind: "relay" as const, deviceId: "guest", workspaceId: "remote-work" };
  const session = { kind: "session" as const };
  const cache = (machine: string, connection: typeof relay | typeof session) =>
    machineSessionCache(storage, "instance", machine, connection);
  await cache("machine", relay).set("relay-chat");
  expect(await cache("machine", relay).get()).toBe("relay-chat");
  expect(await cache("machine", session).get()).toBeUndefined();
  expect(await cache("machine", { ...relay, deviceId: "other-guest" }).get()).toBeUndefined();
  expect(await cache("machine", { ...relay, workspaceId: "other-work" }).get()).toBeUndefined();
  expect(await cache("other-machine", relay).get()).toBeUndefined();
  await cache("machine", session).set("native-chat");
  expect(await cache("machine", session).get()).toBe("native-chat");
  expect(await cache("machine", relay).get()).toBe("relay-chat");
});

test("an untyped cached session cannot prove its connection target", async () => {
  const storage = createMemoryStorage();
  await storage.set("machine-session:instance:machine", "old-relay-or-native-chat");
  expect(await machineSessionCache(storage, "instance", "machine", { kind: "session" }).get()).toBeUndefined();
});
