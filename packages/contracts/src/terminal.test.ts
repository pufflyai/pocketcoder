import { describe, expect, test } from "bun:test";
import {
  AgentFrameSchema,
  ClientTerminalMessageSchema,
  ServerFrameSchema,
  TerminalSessionPageSchema,
} from "./index";

const envelope = {
  v: 4,
  workspace_id: "11111111-1111-4111-8111-111111111111",
  connection_id: "22222222-2222-4222-8222-222222222222",
  seq: 1,
  sent_at: "2026-08-05T12:00:00.000Z",
};

describe("terminal contracts", () => {
  test("accepts bounded terminal frames in both protocol directions", () => {
    expect(
      ServerFrameSchema.parse({
        ...envelope,
        type: "terminal_open",
        payload: {
          session_id: "33333333-3333-4333-8333-333333333333",
          rows: 24,
          cols: 80,
          reattach: false,
        },
      }).type,
    ).toBe("terminal_open");
    expect(
      AgentFrameSchema.parse({
        ...envelope,
        type: "terminal_output",
        payload: {
          session_id: "33333333-3333-4333-8333-333333333333",
          data_b64: Buffer.from("hello").toString("base64"),
        },
      }).type,
    ).toBe("terminal_output");
  });

  test("rejects oversized chunks and invalid dimensions", () => {
    const oversized = Buffer.alloc(32 * 1024 + 1).toString("base64");
    expect(
      ClientTerminalMessageSchema.safeParse({ type: "input", data_b64: oversized }).success,
    ).toBe(false);
    expect(
      ClientTerminalMessageSchema.safeParse({ type: "resize", rows: 0, cols: 80 }).success,
    ).toBe(false);
  });

  test("validates paginated terminal audit resources", () => {
    const parsed = TerminalSessionPageSchema.parse({
      items: [
        {
          session_id: "33333333-3333-4333-8333-333333333333",
          workspace_id: envelope.workspace_id,
          key_id: "44444444-4444-4444-8444-444444444444",
          opened_at: "2026-08-05T12:00:00.000Z",
          closed_at: null,
          duration_ms: null,
          close_reason: null,
          exit_code: null,
          bytes_in: 0,
          bytes_out: 0,
        },
      ],
      next_cursor: null,
    });
    expect(parsed.items).toHaveLength(1);
  });
});
