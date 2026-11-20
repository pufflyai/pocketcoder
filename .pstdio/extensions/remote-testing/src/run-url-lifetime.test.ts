import { expect, test } from "bun:test";
import { runUrlLifetime } from "./run-url-lifetime";

test("source and evidence grants cannot outlive a nearly expired workspace", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const deadline = "2030-01-01T00:04:00Z";
  expect(runUrlLifetime(deadline, 1800, now)).toBe(240);
  expect(runUrlLifetime(deadline, 5400, now)).toBe(240);
  expect(runUrlLifetime("2030-01-01T02:00:00Z", 1800, now)).toBe(1800);
  expect(() => runUrlLifetime(deadline, 1800, now + 240_000)).toThrow("expired");
});
