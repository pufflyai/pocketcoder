import { expect, test } from "bun:test";
import { conversationRetention, conversationRetentionPolicy } from "./conversation-retention";

const hour = 3_600_000;
const template = { conversationRetention: "168h" };

test("templates keep their retention by default", () => {
  expect(conversationRetention(conversationRetentionPolicy({}))(template)).toBe(168 * hour);
});

test("a server maximum caps the template value", () => {
  const policy = conversationRetentionPolicy({ POCKETCODER_MAX_CONVERSATION_RETENTION: "24h" });
  expect(conversationRetention(policy)(template)).toBe(24 * hour);
  expect(conversationRetention(policy)({ conversationRetention: "1h" })).toBe(hour);
});

test("a server override replaces the template value, including keep until deleted", () => {
  expect(
    conversationRetention(conversationRetentionPolicy({ POCKETCODER_CONVERSATION_RETENTION: "720h" }))(template),
  ).toBe(720 * hour);
  expect(
    conversationRetention(conversationRetentionPolicy({ POCKETCODER_CONVERSATION_RETENTION: "until-deleted" }))(
      template,
    ),
  ).toBeNull();
});

test("rejects invalid durations", () => {
  expect(() => conversationRetentionPolicy({ POCKETCODER_CONVERSATION_RETENTION: "soon" })).toThrow(
    "POCKETCODER_CONVERSATION_RETENTION",
  );
});
