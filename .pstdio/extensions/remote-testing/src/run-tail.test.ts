import { expect, test } from "bun:test";
import { logTail } from "./run-tail";

test("bounds both bytes and lines for a large single-line log", () => {
  const tail = logTail("x".repeat(300_000));
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(16 * 1024);
  expect(logTail(Array.from({ length: 100 }, (_, n) => String(n)).join("\n")).split("\n")).toHaveLength(60);
});
