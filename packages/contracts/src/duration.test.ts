import { describe, expect, test } from "bun:test";
import { parseDurationMs } from "./duration";

describe("durations", () => {
  test("parses units", () => {
    expect(parseDurationMs("15s")).toBe(15_000);
    expect(parseDurationMs("20m")).toBe(1_200_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(() => parseDurationMs("2 days")).toThrow();
  });
});
