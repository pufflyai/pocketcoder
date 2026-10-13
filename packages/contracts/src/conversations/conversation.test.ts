import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentFrameSchema, ExecSpecSchema, PROTOCOL_VERSION, SOURCE_CREDENTIAL_MAX_BYTES } from "../protocol/protocol";
import { ConversationMessageInputSchema } from "./conversation";

test("restricted exec specs carry only local firewall endpoints", () => {
  const network = ExecSpecSchema.shape.network.parse({
    mode: "restricted",
    proxy_url: "http://127.0.0.1:18080",
    health_url: "http://127.0.0.1:18082/healthz",
  });
  expect(network.mode).toBe("restricted");
});

test("source credentials are values for setup rather than mounted paths", () => {
  const source = ExecSpecSchema.shape.source.parse({
    kind: "git",
    repository: "app",
    revision: "main",
    url: "https://github.com/example/app.git",
    destination: "/workspace",
    credential: "short-lived-git-token",
  });
  expect(source).toMatchObject({ credential: "short-lived-git-token" });
  expect(source).not.toHaveProperty("credential_path");
  expect(
    ExecSpecSchema.shape.source.safeParse({
      ...source,
      credential: "x".repeat(SOURCE_CREDENTIAL_MAX_BYTES + 1),
    }).success,
  ).toBe(false);
});

describe("conversation contracts", () => {
  test("preserves externally issued turn and event identities in conversation frames", () => {
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: "10000000-0000-4000-8000-000000000001",
      request_id: "10000000-0000-4000-8000-000000000002",
      turn_id: "10000000-0000-4000-8000-000000000003",
      request_fingerprint: "a".repeat(64),
      event_id: "10000000-0000-4000-8000-000000000004",
      message_id: "answer-1",
      sequence: 1,
      revision: 1,
    };
    const payload = {
      message_id: "event-1:1",
      role: "assistant" as const,
      content: "New answer",
      occurred_at: "2026-10-13T12:00:00Z",
      metadata: {},
      identity,
    };
    expect(ConversationMessageInputSchema.parse(payload)).toEqual(payload);
    const frame = AgentFrameSchema.parse({
      v: PROTOCOL_VERSION,
      type: "conversation_message",
      workspace_id: "10000000-0000-4000-8000-000000000005",
      connection_id: "10000000-0000-4000-8000-000000000006",
      seq: 2,
      sent_at: "2026-10-13T12:00:00Z",
      payload,
    });
    expect(frame.payload).toEqual(payload);
  });

  test("accepts bounded canonical messages and protocol frames", () => {
    const payload = {
      message_id: "provider-message-1",
      role: "assistant" as const,
      content: "Implemented the change.",
      occurred_at: new Date().toISOString(),
      metadata: { provider: "agentapi" },
    };
    expect(ConversationMessageInputSchema.parse(payload)).toEqual(payload);
    expect(
      AgentFrameSchema.safeParse({
        v: PROTOCOL_VERSION,
        type: "conversation_message",
        workspace_id: randomUUID(),
        connection_id: randomUUID(),
        seq: 2,
        sent_at: new Date().toISOString(),
        payload,
      }).success,
    ).toBe(true);
  });

  test("rejects oversized content and unbounded metadata", () => {
    expect(
      ConversationMessageInputSchema.safeParse({
        message_id: "m",
        role: "user",
        content: "x".repeat(256 * 1024 + 1),
        occurred_at: new Date().toISOString(),
        metadata: {},
      }).success,
    ).toBe(false);
    expect(
      ConversationMessageInputSchema.safeParse({
        message_id: "m",
        role: "user",
        content: "ok",
        occurred_at: new Date().toISOString(),
        metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"])),
      }).success,
    ).toBe(false);
  });
});
