import { expect, test } from "bun:test";
import { ViewAdmission } from "../previews/admission";
import { DisplayAdmission } from "./admission";

test("one controller and five display streams share a workspace lease released exactly once", () => {
  const admission = new DisplayAdmission(new ViewAdmission());
  const control = admission.reserve("workspace", true);
  expect(() => admission.reserve("workspace", true)).toThrow();
  const viewers = Array.from({ length: 4 }, () => admission.reserve("workspace", false));
  expect(() => admission.reserve("workspace", false)).toThrow();
  control();
  control();
  const replacement = admission.reserve("workspace", true);
  expect(() => admission.reserve("workspace", true)).toThrow();
  replacement();
  for (const release of viewers) release();
  expect(() => admission.reserve("workspace", true)).not.toThrow();
});
