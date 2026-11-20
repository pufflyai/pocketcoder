import { expect, test } from "bun:test";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { activeRun, claimEnvironment, releaseEnvironment } from "./environments";

test("concurrent reuse claims have one owner, and another run cannot release it", async () => {
  const store = createMemoryStorage();
  const claims = await Promise.all([claimEnvironment(store, "env", "a", 60), claimEnvironment(store, "env", "b", 60)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const owner = await activeRun(store, "env");
  await releaseEnvironment(store, "env", owner === "a" ? "b" : "a");
  expect(await activeRun(store, "env")).toBe(owner);
  await releaseEnvironment(store, "env", owner!);
  expect(await activeRun(store, "env")).toBeNull();
  expect(await claimEnvironment(store, "env", "next", 60)).toBe(true);
});
