import { expect, test } from "bun:test";
import { normalizeMessages, turnFinished } from "./agent";

test("normalizes AgentAPI messages without IDs and ignores earlier completed turns", () => {
  const messages = [
    { role: "user", content: "old" },
    { role: "agent", content: "old answer" },
  ];
  expect(normalizeMessages("machine", messages)).toMatchObject([
    { id: "pocketcoder:machine:0", role: "user", index: 0, parts: [{ type: "text", text: "old" }] },
    { id: "pocketcoder:machine:1", role: "assistant", index: 1, parts: [{ type: "text", text: "old answer" }] },
  ]);
  expect(turnFinished(messages, 2, "stable")).toBe(false);
  expect(turnFinished([...messages, { role: "agent", content: "new answer" }], 2, "running")).toBe(false);
  expect(turnFinished([...messages, { role: "agent", content: "new answer" }], 2, "stable")).toBe(true);
});
