import { expect, test } from "bun:test";
import { workloadFixture } from "./workload-fixtures.test";
import { parseWorkloadTemplate } from "./workload-template";

test("operation schemas reject invalid property definitions and support structured bounded types", () => {
  for (const property of [
    17,
    null,
    { type: 17 },
    { type: "unrecognized" },
    { type: "array" },
    { type: "string", invented: true },
  ]) {
    const fixture = workloadFixture();
    Reflect.set(fixture.spec.operations.run.inputSchema.properties, "count", property);
    expect(() => parseWorkloadTemplate(fixture)).toThrow();
  }
  const fixture = workloadFixture();
  Reflect.set(fixture.spec.operations.run.inputSchema.properties, "names", {
    type: "array",
    items: { type: "string" },
  });
  expect(parseWorkloadTemplate(fixture).manifest.spec.operations.run?.inputSchema.properties.names).toEqual({
    type: "array",
    items: { type: "string" },
  });
});
