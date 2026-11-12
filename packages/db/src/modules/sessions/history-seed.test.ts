import { expect, test } from "bun:test";
import { boundedHistorySeed } from "./history-seed";

test("history seed keeps the newest complete messages within the byte bound", () => {
  const messages = [
    { role: "user" as const, content: "old".repeat(100) },
    { role: "assistant" as const, content: "We chose blue." },
  ];
  const seed = boundedHistorySeed(messages, 100);
  expect(seed.messages).toEqual([messages[1]!]);
  expect(seed.trimmed).toBe(true);
  expect(boundedHistorySeed(messages, 10000)).toEqual({ messages, trimmed: false });
});
