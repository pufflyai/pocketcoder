import { expect, test } from "bun:test";
import { RuntimeMetrics } from "@pstdio/pocketcoder-runtime-core";
import { Hono } from "hono";
import { Readiness } from "./health";
import { type AppEnv, requestId, requestLogging } from "./middleware";
import { createStructuredLogger } from "./observability";

test("structured logs carry stable context without formatting it into messages", () => {
  const records: unknown[] = [];
  const log = createStructuredLogger(
    (record) => records.push(record),
    () => new Date("2026-08-04T12:00:00Z"),
  );

  log.info("request.completed", {
    request_id: "request-1",
    workspace_id: "workspace-1",
    method: "GET",
    status: 200,
  });

  expect(records).toEqual([
    {
      timestamp: "2026-08-04T12:00:00.000Z",
      level: "info",
      event: "request.completed",
      request_id: "request-1",
      workspace_id: "workspace-1",
      method: "GET",
      status: 200,
    },
  ]);
});

test("readiness failures are counted by dependency", () => {
  const metrics = new RuntimeMetrics();
  const readiness = new Readiness({}, metrics);
  readiness.set("schema", "failed");
  readiness.set("reconciliation", "failed");

  expect(metrics.snapshot().counters).toEqual({
    'readiness.failure.total{check="schema"}': 1,
    'readiness.failure.total{check="reconciliation"}': 1,
  });
});

test("request logging propagates request context and duration", async () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createStructuredLogger((record) => records.push(record));
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", requestLogging(logger));
  app.get("/workspaces/:id", (context) => context.json({ ok: true }));

  const response = await app.request("/workspaces/workspace-1", {
    headers: { "x-request-id": "request-1" },
  });

  expect(response.headers.get("x-request-id")).toBe("request-1");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    event: "request.completed",
    request_id: "request-1",
    method: "GET",
    path: "/workspaces/workspace-1",
    status: 200,
  });
  expect(records[0]?.duration_ms).toBeNumber();
});
