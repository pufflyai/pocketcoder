import { expect, test } from "bun:test";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { dismissMachine } from "./machine-dismissal";

test("parallel dismissals retain every machine and existing dismissals", async () => {
  const storage = createMemoryStorage();
  await storage.set("dismissed-machines:instance", ["previous"]);
  const ids = Array.from({ length: 12 }, (_, i) => `machine-${i}`);
  await Promise.all(ids.map((id) => dismissMachine(storage, "instance", id)));
  await dismissMachine(storage, "instance", "machine-0");
  expect((await storage.get<string[]>("dismissed-machines:instance"))?.sort()).toEqual(["previous", ...ids].sort());
  expect(await storage.get("dismissed-machines:other")).toBeUndefined();
});
