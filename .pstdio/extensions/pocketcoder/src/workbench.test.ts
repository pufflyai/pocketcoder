import { expect, test } from "bun:test";
import { instancePage, instancesPage, navigation } from "./workbench";

test("Lab navigation restores its page and keeps instances in the Lab hierarchy", () => {
  expect(navigation.action).toEqual({ kind: "page", page: instancesPage.ref, intent: "restore" });
  expect(instancePage.parent).toEqual(instancesPage.ref);
});
