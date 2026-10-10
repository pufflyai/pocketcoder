import { verifyEgressAuditToken } from "@pstdio/pocketcoder-auth";
import { NetworkEventBatchSchema } from "@pstdio/pocketcoder-contracts";
import type { WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import type { createBunWebSocket } from "hono/bun";
import type { Screenshots } from "../displays/screenshots";
import { type AppEnv, errorHandler, requestId, requestLogging } from "../http/middleware";
import type { StructuredLogger } from "../observability/observability";
import type { CheckpointTransferService } from "../persistence/checkpoint-transfer";
import { type PoolConnectionHub, poolConnectValidator, poolWsEvents } from "./pool-ws";
import { agentConnectValidator, agentWsEvents } from "./ws";
import type { WsDeps } from "./ws-types";

interface AgentAppDeps {
  screenshots?: Screenshots;
  connection: WsDeps;
  poolHub: PoolConnectionHub;
  checkpointTransfers?: Pick<CheckpointTransferService, "handleUpload" | "handleDownload">;
  warmPool?: WarmPoolManager;
  eventSigningKey: string;
  logger: StructuredLogger;
  upgradeWebSocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["upgradeWebSocket"];
}

export function createAgentApp({
  connection,
  screenshots,
  poolHub,
  checkpointTransfers,
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
  if (screenshots) app.put("/v1/agent/screenshots/:id", (c) => screenshots.upload(c.req.raw, c.req.param("id")));
  if (checkpointTransfers) {
    app.put("/v1/agent/checkpoints/:operationId/archive", (c) =>
      checkpointTransfers.handleUpload(c.req.raw, c.req.param("operationId")),
    );
    app.get("/v1/agent/checkpoints/:operationId/archive", (c) =>
      checkpointTransfers.handleDownload(c.req.raw, c.req.param("operationId")),
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
