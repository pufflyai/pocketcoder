import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  LogListQuerySchema,
  LogPageSchema,
  NetworkEventPageSchema,
  NetworkEventsQuerySchema,
  TerminalSessionListQuerySchema,
  TerminalSessionPageSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { decodeSequenceCursor, decodeStringCursor, encodeCursor } from "../pagination";
import type { WorkspaceService } from "../service";
import { COMMON_ERROR_RESPONSES } from "./shared";

export function registerDiagnosticRoutes({
  app,
  store,
  service,
}: {
  app: OpenAPIHono<AppEnv>;
  store: Store;
  service: WorkspaceService;
}) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/network-events",
      operationId: "listWorkspaceNetworkEvents",
      tags: ["Diagnostics"],
      middleware: [requireScope("network:read")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: NetworkEventsQuerySchema,
      },
      responses: {
        200: {
          description: "Durable workspace egress decisions",
          content: {
            "application/json": {
              schema: NetworkEventPageSchema,
            },
          },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("network-events", cursor);
      await service.getOwned(principal, id);
      const rows = await store.readNetworkEvents(id, after, limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map((event) => ({
            seq: event.seq,
            workspace_id: event.workspaceId,
            source_session_id: event.sourceSessionId,
            source_seq: event.source_seq,
            occurred_at: event.occurred_at,
            decision: event.decision,
            transport: event.transport,
            host: event.host,
            port: event.port,
            method: event.method,
            path: event.path,
            matched_rule: event.matched_rule,
            reason: event.reason,
          })),
          next_cursor: hasMore && last ? encodeCursor("network-events", last.seq) : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/terminal-sessions",
      operationId: "listWorkspaceTerminalSessions",
      tags: ["Diagnostics"],
      middleware: [requireScope("terminal:read")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: TerminalSessionListQuerySchema,
      },
      responses: {
        200: {
          description: "Durable workspace terminal session audit",
          content: { "application/json": { schema: TerminalSessionPageSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const after = decodeStringCursor("terminal-sessions", cursor);
      await service.getOwned(principal, id);
      const rows = await store.listTerminalSessions(id, after, limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map((session) => ({
            session_id: session.sessionId,
            workspace_id: session.workspaceId,
            key_id: session.keyId,
            opened_at: session.openedAt.toISOString(),
            closed_at: session.closedAt?.toISOString() ?? null,
            duration_ms: session.closedAt
              ? session.closedAt.getTime() - session.openedAt.getTime()
              : null,
            close_reason: session.closeReason,
            exit_code: session.exitCode,
            bytes_in: session.bytesIn,
            bytes_out: session.bytesOut,
          })),
          next_cursor: hasMore && last ? encodeCursor("terminal-sessions", last.sessionId) : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces/{id}/logs",
      operationId: "listWorkspaceLogs",
      tags: ["Diagnostics"],
      middleware: [requireScope("logs:read")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
        query: LogListQuerySchema,
      },
      responses: {
        200: {
          description: "Bounded operational log chunks",
          content: {
            "application/json": {
              schema: LogPageSchema,
            },
          },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const after = decodeSequenceCursor("logs", cursor);
      await service.getOwned(principal, id);
      const rows = await store.readLogs(id, after, limit + 1);
      const hasMore = rows.length > limit;
      const logs = rows.slice(0, limit);
      const last = logs.at(-1);
      return c.json(
        {
          items: logs.map((l) => ({
            seq: l.seq,
            stream: l.stream,
            occurred_at: l.occurredAt.toISOString(),
            content: Buffer.from(l.content).toString("utf8"),
          })),
          next_cursor: hasMore && last ? encodeCursor("logs", last.seq) : null,
        },
        200,
      );
    },
  );
}
