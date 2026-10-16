import { expect, test } from "bun:test";
import { assertSuiteCoverage, suiteGroups } from "./suite";

test("the full CI groups preserve every command from the real root test suite exactly once", async () => {
  const manifest = await Bun.file(new URL("../../package.json", import.meta.url)).json();
  expect(() => assertSuiteCoverage(manifest.scripts["test:all"])).not.toThrow();
});

test("adding an unassigned root suite cannot silently skip its tests in CI", () => {
  expect(() => assertSuiteCoverage("bun run test:unit && bun run test:new")).toThrow("test:new");
});

test("the reusable example tests have one full-validation owner", () => {
  expect(
    Object.values(suiteGroups)
      .flat()
      .filter((command) => command === "example:test"),
  ).toHaveLength(1);
});
