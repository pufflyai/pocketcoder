import type { OpenAPIHono } from "@hono/zod-openapi";
import { verifyEgressAuditToken } from "@pstdio/pocketcoder-auth";
import { NetworkEventBatchSchema } from "@pstdio/pocketcoder-contracts";
import type {
  AdmissionLimits,
  RuntimeOperations as ControllerOperations,
  MetricSink,
  ResolvedWarmPool,
  Scheduler,
  SchedulerDeps,
  Store,
  WarmPoolManager,
  WorkspaceDriver,
  WorkspaceSecretResolver,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";
import { registerAdministrationRoutes } from "./administration/administration-routes";
import { registerKeyRoutes } from "./administration/keys-routes";
import { registerOperatorRecoveryRoutes } from "./administration/recovery-routes";
import { agentMessageBodyTransform, attachmentUploadHandler } from "./attachments/attachments";
import type { Hub } from "./control-channel/hub";
import { poolConnectValidator, poolWsEvents } from "./control-channel/pool-ws";
import { agentConnectValidator, agentWsEvents } from "./control-channel/ws";
import { registerConversationRoutes } from "./conversations/conversations-routes";
import { createControllerHttp } from "./http/controller-http";
import { type AppEnv, machineAuth, requireScope } from "./http/middleware";
import { buildControllerRuntime } from "./lifecycle/controller-runtime";
import { ownWebSocket } from "./lifecycle/controller-websocket";
import { registerDiagnosticRoutes } from "./observability/diagnostics-routes";
import type { Readiness } from "./observability/health";
import type { StructuredLogger } from "./observability/observability";
import { registerCheckpointRoutes } from "./persistence/checkpoints-routes";
import type { PersistenceLimits, PersistenceService } from "./persistence/persistence";
import { registerPurgeRoutes } from "./persistence/purge-routes";
import { registerRecoveryRoutes } from "./persistence/recovery-routes";
import { relayHandler } from "./relay/relay";
import { registerCatalogRoutes } from "./templates/catalog-routes";
import { terminalConnectValidator, terminalWsEvents } from "./terminals/terminal-ws";
import type { WorkspaceService } from "./workspaces/service";
import { registerWorkspaceRoutes } from "./workspaces/workspaces-routes";

export interface BuildDeps {
  authorizeLaunch?: SchedulerDeps["authorizeLaunch"];
  store: Store;
  driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
  storageDriver?: WorkspaceStorageDriver;
  secretResolver?: WorkspaceSecretResolver;
  persistenceLimits?: PersistenceLimits;
  pepper: string;
  eventSigningKey?: string;
  limits: AdmissionLimits;
  workspaceServerUrl: string;
  instanceId?: string;
  logger?: StructuredLogger;
  metrics?: MetricSink;
  warmPools?: ResolvedWarmPool[];
  readiness?: Readiness;
}

export interface BuiltServer {
  app: OpenAPIHono<AppEnv>;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
  hub: Hub;
  scheduler: Scheduler;
  service: WorkspaceService;
  persistence: PersistenceService;
  warmPool?: WarmPoolManager;
  metrics: MetricSink;
  operations: ControllerOperations;
}

export function buildServer(deps: BuildDeps): BuiltServer {
  const { pepper } = deps;
  const {
    store,
    driver,
    secretResolver,
    logger,
    metrics,
    log,
    hub,
    poolHub,
    warmPool,
    scheduler,
    service,
    persistence,
    operations,
  } = buildControllerRuntime(deps);

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  const app = createControllerHttp(operations, logger, deps);

  // Agent supervisor connection; authenticated by registration/reconnect
  // credentials, not machine keys, so it is registered before machineAuth.
  const wsDeps = {
    store,
    hub,
    scheduler,
    pepper,
    ...(secretResolver ? { secretResolver } : {}),
    ...(driver.cleanupInput ? { cleanupInput: (id: string) => driver.cleanupInput?.(id) ?? Promise.resolve() } : {}),
    log,
    persistence,
  };
  app.get(
    "/v1/agent/connect",
    agentConnectValidator(wsDeps),
    upgradeWebSocket(ownWebSocket(agentWsEvents(wsDeps), operations)),
  );
  if (warmPool) {
    app.get(
      "/v1/agent/pool-connect",
      poolConnectValidator({ store, pepper }),
      upgradeWebSocket(ownWebSocket(poolWsEvents({ store, hub: poolHub, manager: warmPool, log }), operations)),
    );
  }
  app.post("/v1/internal/egress/events", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const subject = verifyEgressAuditToken(deps.eventSigningKey ?? pepper, token);
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
    if (!workspaceId || !(await store.getWorkspace(workspaceId))) {
      return c.json({ error: "audit_subject_unassigned" }, 409);
    }
    await store.appendNetworkEvents(workspaceId, parsed.data.source_session_id, parsed.data.events);
    return c.json({ accepted: parsed.data.events.length }, 202);
  });

  // The generated OpenAPI document is served without machine auth so
  // tooling can consume the contract; it contains no secrets.
  app.doc("/v1/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "pocketcoder",
      version: "0.1.0",
      description: "MIT-licensed control plane for coding agents in isolated workspaces.",
    },
  });

  app.use("/v1/*", machineAuth(store, pepper));

  registerCatalogRoutes({ app, store });
  registerKeyRoutes(app, store, pepper);
  registerOperatorRecoveryRoutes(app, store, persistence);
  registerAdministrationRoutes({ app, persistence, warmPool });
  registerCheckpointRoutes({ app, store, service, persistence });
  registerRecoveryRoutes({ app, store, service, persistence });
  registerPurgeRoutes(app, persistence);
  registerConversationRoutes({ app, store, service });
  registerWorkspaceRoutes({ app, store, service });
  registerDiagnosticRoutes({ app, store, service });
  const terminalDeps = { store, hub, service };
  app.get(
    "/v1/workspaces/:id/terminal",
    requireScope("terminal:attach"),
    terminalConnectValidator(terminalDeps),
    upgradeWebSocket(ownWebSocket(terminalWsEvents(terminalDeps), operations)),
  );

  // --- Templates ---

  // --- Workspace attachments ---

  const relayDeps = { store, hub, service };
  app.put(
    "/v1/workspaces/:id/attachments/:attachmentId",
    requireScope("attachments:write"),
    attachmentUploadHandler(relayDeps),
  );

  // --- Workspace service relay ---

  // The AgentAPI message aliases are registered before the wildcard relay
  // routes so attachment references resolve on both spellings.
  const messageTransform = agentMessageBodyTransform(relayDeps);
  app.post(
    "/v1/workspaces/:id/agent/message",
    requireScope("services:relay"),
    relayHandler(relayDeps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
      transformBodyB64: messageTransform,
    }),
  );
  app.post(
    "/v1/workspaces/:id/services/agent/message",
    requireScope("services:relay"),
    relayHandler(relayDeps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/services/agent`,
      transformBodyB64: messageTransform,
    }),
  );
  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/v1/workspaces/:id/services/:service/*",
    requireScope("services:relay"),
    relayHandler(relayDeps),
  );
  app.on(
    ["GET", "POST"],
    "/v1/workspaces/:id/agent/*",
    requireScope("services:relay"),
    relayHandler(relayDeps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
    }),
  );

  return {
    app,
    websocket,
    hub,
    scheduler,
    service,
    persistence,
    metrics,
    operations,
    ...(warmPool ? { warmPool } : {}),
  };
}
