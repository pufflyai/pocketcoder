import { expect, test } from "bun:test";
import { catalogPage, instancePage, instancesPage, navigation } from "./workbench";

test("Lab navigation restores its page and keeps instances in the Lab hierarchy", () => {
  expect(navigation.action).toEqual({ kind: "page", page: instancesPage.ref, intent: "restore" });
  expect(instancePage.parent).toEqual(instancesPage.ref);
});

test("the Lab opens straight on its instance table, with the template catalog as a separate page", () => {
  expect(instancesPage.main).toMatchObject({ kind: "view", cardinality: "one" });
  expect(instancesPage.slots).toEqual([]);
  expect(catalogPage.parent).toEqual(instancesPage.ref);
});
