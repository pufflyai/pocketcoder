import { expect, test } from "bun:test";
import { DisplayAdmission } from "../displays/admission";
import { ViewAdmission } from "./admission";

test("preview and display streams share workspace and instance limits", () => {
  const views = new ViewAdmission();
  const displays = new DisplayAdmission(views);
  const release: (() => void)[] = [];
  for (let index = 0; index < 32; index++) release.push(views.reserve("one", "a"), views.reserve("one", "b"));
  expect(() => displays.reserve("one", false)).toThrow();
  release.pop()?.();
  const control = displays.reserve("one", true);
  for (let index = 0; index < 32; index++) release.push(views.reserve("two", "a"), views.reserve("two", "b"));
  expect(() => displays.reserve("three", false)).toThrow();
  control();
  control();
  const final = displays.reserve("three", false);
  expect(() => views.reserve("four", "a")).toThrow();
  final();
  for (const stop of release) stop();
});
