import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { streamSSE } from "hono/streaming";
import type { LiveTurns } from "../conversations/live-turns";
import { MANAGED_ERROR_RESPONSES } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";
import { registerConversationRoute } from "./conversation-route";

const PAGE = 100;
const KEEPALIVE_MS = 15_000;

// Events are read from durable observations, so a stream survives controller restarts and a
// reconnect resumes from its last cursor. A disconnect never touches the session's work.
export function registerSessionHistoryRoutes(
  app: OpenAPIHono<AppEnv>,
  store: Store,
  options: { pollMs: number; liveTurns: LiveTurns },
) {
  registerConversationRoute(app, store, options.liveTurns);
  const base = "/v1/sessions/{sessionId}";
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/history`,
      tags: ["Managed sessions"],
      operationId: "getManagedHistory",
      middleware: [requireScope("sessions:read")] as const,
      request: {
        params: z.object({ sessionId: z.uuid() }),
        query: z.object({
          cursor: z.string().min(1).max(4096).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: {
        200: {
          description: "Retained canonical records and the event watermark to subscribe after",
          content: { "application/json": { schema: managed.ManagedHistoryPageSchema } },
        },
        ...MANAGED_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { cursor, limit } = c.req.valid("query");
      const page = await store.managed.history.history(
        c.get("keyId"),
        c.req.valid("param").sessionId,
        cursor ?? null,
        limit,
      );
      return c.json(page, 200);
    },
  );
  app.get("/v1/sessions/:sessionId/events", requireScope("sessions:read"), async (c) => {
    const keyId = c.get("keyId");
    const sessionId = z.uuid().parse(c.req.param("sessionId"));
    const start = c.req.query("after") ?? c.req.header("last-event-id") ?? null;
    // The first read runs before streaming starts, so an invalid or expired cursor gets its HTTP status.
    const batch = await store.managed.history.events(keyId, sessionId, start, PAGE);
    return streamSSE(c, (sse) =>
      replay(
        sse,
        batch,
        start,
        (cursor) => store.managed.history.events(keyId, sessionId, cursor, PAGE),
        options.pollMs,
      ),
    );
  });
}

type Stream = Parameters<Parameters<typeof streamSSE>[1]>[0];
type RuntimeEvent = Awaited<ReturnType<Store["managed"]["history"]["events"]>>[number];

// Writes each durable event once per connection, then polls after the last cursor it sent.
async function replay(
  sse: Stream,
  first: RuntimeEvent[],
  start: string | null,
  read: (cursor: string | null) => Promise<RuntimeEvent[]>,
  pollMs: number,
) {
  let batch = first;
  let cursor = start;
  let quiet = 0;
  const open = () => !sse.aborted && !sse.closed;
  while (open()) {
    for (const event of batch) {
      await sse.writeSSE({ id: event.cursor, event: event.kind, data: JSON.stringify(event) });
      cursor = event.cursor;
    }
    quiet = batch.length ? 0 : quiet;
    if (batch.length < PAGE) quiet += await idle(sse, pollMs, quiet);
    if (!open()) return;
    try {
      batch = await read(cursor);
    } catch (error) {
      // Revoked authority or expired retention ends the stream with a safe reason.
      const code = error instanceof ApiError ? error.code : "internal.error";
      await sse.writeSSE({ event: "error", data: JSON.stringify({ code }) });
      return;
    }
  }
}

async function idle(sse: Stream, pollMs: number, quiet: number) {
  await sse.sleep(pollMs);
  if (quiet + pollMs < KEEPALIVE_MS) return pollMs;
  await sse.writeSSE({ event: "keepalive", data: "{}" });
  return -quiet;
}
