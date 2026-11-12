import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, digestOf, managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { LiveTurns } from "../conversations/live-turns";
import { MANAGED_ERROR_RESPONSES } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

const Cursor = z.object({
  instance: z.string(),
  session: z.string(),
  events: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  live: z.string(),
});

export function registerConversationRoute(app: OpenAPIHono<AppEnv>, store: Store, live: LiveTurns) {
  const instance = randomUUID();
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions/{sessionId}/conversation",
      operationId: "getSessionConversation",
      tags: ["Managed sessions"],
      middleware: [requireScope("sessions:read")] as const,
      request: {
        params: z.object({ sessionId: z.uuid() }),
        query: z.object({ after: z.string().max(4096).optional() }),
      },
      responses: {
        200: {
          description: "Conversation changes, or a full snapshot after reset",
          content: { "application/json": { schema: managed.SessionConversationSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param"),
        { after } = c.req.valid("query");
      // Read live before durable state: a turn that commits between these reads is deduplicated.
      const binding = await store.managed.sessions.binding(c.get("keyId"), sessionId);
      const turns = binding ? live.open(binding.workspaceId, sessionId) : [];
      const owner = digestOf({ principal: c.get("principal").id, sessionId });
      let cursor: z.infer<typeof Cursor> | undefined;
      let reset = false;
      if (after) {
        try {
          const raw = JSON.parse(Buffer.from(after, "base64url").toString());
          const header = Cursor.pick({ instance: true, session: true }).parse(raw);
          if (header.session !== owner) throw new Error("Foreign cursor");
          reset = header.instance !== instance;
          if (!reset) cursor = Cursor.parse(raw);
        } catch {
          throw new ApiError("events.cursor_invalid", "Invalid conversation cursor.");
        }
      }
      const snapshot = await store.managed.history.snapshot(c.get("keyId"), sessionId, cursor);
      reset ||= snapshot.reset;
      const fingerprint = digestOf(turns);
      const changedTurns = reset || !cursor || cursor.live !== fingerprint ? turns : [];
      const messages = conversationMessages(snapshot, changedTurns);
      return c.json(
        {
          session: { state: snapshot.session.state, reasonCode: snapshot.session.reasonCode },
          requests: snapshot.requests,
          messages: [...messages.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
          cursor: Buffer.from(
            JSON.stringify({
              instance,
              session: owner,
              events: Number(snapshot.eventCursor.split(":")[1]),
              records: snapshot.recordCursor,
              live: fingerprint,
            }),
          ).toString("base64url"),
          reset,
        },
        200,
      );
    },
  );
}

function conversationMessages(
  snapshot: Awaited<ReturnType<Store["managed"]["history"]["snapshot"]>>,
  turns: ReturnType<LiveTurns["open"]>,
) {
  const messages = new Map<string, managed.SessionMessage>();
  const add = (
    requestId: string | undefined,
    turnId: string,
    items: {
      message_id: string;
      role: managed.SessionMessage["role"];
      content: string;
      parts?: managed.SessionMessage["parts"];
      occurred_at: string;
    }[],
    final: boolean,
  ) => {
    if (!requestId) return;
    for (const message of items)
      messages.set(message.message_id, {
        messageId: message.message_id,
        requestId,
        turnId,
        role: message.role,
        parts: message.parts ?? [{ type: "text", text: message.content }],
        occurredAt: message.occurred_at,
        final,
      });
  };
  for (const turn of turns)
    if (turn.type === "turn") add(turn.messages[0]?.identity?.request_id, turn.turn_id, turn.messages, false);
  for (const record of snapshot.records)
    if (record.turn_id) add(record.request?.request_id, record.turn_id, record.messages, true);
  return messages;
}
