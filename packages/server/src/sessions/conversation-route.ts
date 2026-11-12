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
  events: z.string(),
  version: z.number().int().nonnegative(),
});
type Tracked = { digest: string; version: number };

export function registerConversationRoute(app: OpenAPIHono<AppEnv>, store: Store, live: LiveTurns) {
  const instance = randomUUID();
  const views = new Map<string, { version: number; items: Map<string, Tracked> }>();
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
      const snapshot = await store.managed.history.snapshot(c.get("keyId"), sessionId);
      const owner = digestOf({ principal: c.get("principal").id, sessionId });
      let cursor: z.infer<typeof Cursor> | undefined;
      if (after) {
        try {
          cursor = Cursor.parse(JSON.parse(Buffer.from(after, "base64url").toString()));
        } catch {
          throw new ApiError("events.cursor_invalid", "Invalid conversation cursor.");
        }
        if (cursor.session !== owner)
          throw new ApiError("events.cursor_invalid", "Cursor does not belong to this session.");
      }
      const known = views.get(owner);
      const reset = Boolean(after && (cursor?.instance !== instance || !known || cursor.version > known.version));
      const view = known ?? { version: 0, items: new Map<string, Tracked>() };
      const messages = conversationMessages(snapshot, turns);
      const from = reset || !cursor ? -1 : cursor.version;
      const changed = (key: string, value: unknown) => {
        const digest = digestOf(value),
          previous = view.items.get(key);
        if (previous?.digest !== digest) view.items.set(key, { digest, version: ++view.version });
        return (view.items.get(key)?.version ?? 0) > from;
      };
      const requests = snapshot.requests.filter((r) => changed(`request:${r.requestId}`, r));
      const updates = [...messages.values()]
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .filter((m) => changed(`message:${m.messageId}`, m));
      views.set(owner, view);
      return c.json(
        {
          session: { state: snapshot.session.state, reasonCode: snapshot.session.reasonCode },
          requests,
          messages: updates,
          cursor: Buffer.from(
            JSON.stringify({ instance, session: owner, events: snapshot.eventCursor, version: view.version }),
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
    const request = snapshot.requests.find((r) => r.turnId === turnId);
    if (!request) return;
    for (const message of items)
      messages.set(message.message_id, {
        messageId: message.message_id,
        requestId: request.requestId,
        turnId,
        role: message.role,
        parts: message.parts ?? [{ type: "text", text: message.content }],
        occurredAt: message.occurred_at,
        final,
      });
  };
  for (const turn of turns) if (turn.type === "turn") add(turn.turn_id, turn.messages, false);
  for (const record of snapshot.records) if (record.turn_id) add(record.turn_id, record.messages, true);
  return messages;
}
