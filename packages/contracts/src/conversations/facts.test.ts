import { expect, test } from "bun:test";
import { ConversationFactSchema } from "./facts";

const activity = {
  type: "activity_started" as const,
  activity_id: "10000000-0000-4000-8000-000000000011",
  kind: "tool" as const,
  label: "Read files",
  started_at: null,
};

test("producer step and failure codes survive parsing", () => {
  expect(ConversationFactSchema.parse({ ...activity, action: "read_file", subject: "contract_pdf" })).toEqual({
    ...activity,
    action: "read_file",
    subject: "contract_pdf",
  });
  expect(ConversationFactSchema.parse({ type: "turn_terminal", outcome: "failed", reason: "model_timeout" })).toEqual({
    type: "turn_terminal",
    outcome: "failed",
    reason: "model_timeout",
  });
  expect(ConversationFactSchema.parse(activity)).toEqual(activity);
});

test("codes outside the producer pattern are rejected", () => {
  expect(ConversationFactSchema.safeParse({ ...activity, action: "Read File" }).success).toBe(false);
  expect(
    ConversationFactSchema.safeParse({ type: "turn_terminal", outcome: "failed", reason: "x".repeat(65) }).success,
  ).toBe(false);
});
