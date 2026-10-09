import { verifyEgressAuditToken } from "@pstdio/pocketcoder-auth";
import { NetworkEventBatchSchema } from "@pstdio/pocketcoder-contracts";
import type { WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import type { createBunWebSocket } from "hono/bun";
import { type AppEnv, errorHandler, requestId, requestLogging } from "../http/middleware";
import type { StructuredLogger } from "../observability/observability";
import { type PoolConnectionHub, poolConnectValidator, poolWsEvents } from "./pool-ws";
import { agentConnectValidator, agentWsEvents } from "./ws";
import type { WsDeps } from "./ws-types";

interface AgentAppDeps {
  connection: WsDeps;
  poolHub: PoolConnectionHub;
  warmPool?: WarmPoolManager;
  eventSigningKey: string;
  logger: StructuredLogger;
  upgradeWebSocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["upgradeWebSocket"];
}

export function createAgentApp({
  connection,
  poolHub,
  warmPool,
  eventSigningKey,
  logger,
  upgradeWebSocket,
}: AgentAppDeps) {
  const { store, pepper, log } = connection;
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(logger));
  app.use("*", requestId);
  app.use("*", requestLogging(logger));
  app.get("/v1/agent/connect", agentConnectValidator(connection), upgradeWebSocket(agentWsEvents(connection)));
  if (warmPool) {
    app.get(
      "/v1/agent/pool-connect",
      poolConnectValidator({ store, pepper }),
      upgradeWebSocket(
        poolWsEvents({
          store,
          hub: poolHub,
          manager: warmPool,
          log,
        }),
      ),
    );
  }
  app.post("/v1/internal/egress/events", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const subject = verifyEgressAuditToken(eventSigningKey, token);
    if (!subject) return c.json({ error: "invalid_audit_token" }, 401);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return c.json({ error: "batch_too_large" }, 413);
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // Stable invalid_batch response below.
    }
    const parsed = NetworkEventBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_batch" }, 400);
    const workspaceId =
      subject.kind === "workspace" ? subject.id : (await store.getWarmPoolRuntime(subject.id))?.workspaceId;
    if (!workspaceId || !(await store.getWorkspace(workspaceId)))
      return c.json({ error: "audit_subject_unassigned" }, 409);
    await store.appendNetworkEvents(workspaceId, parsed.data.source_session_id, parsed.data.events);
    return c.json({ accepted: parsed.data.events.length }, 202);
  });

  return app;
}
