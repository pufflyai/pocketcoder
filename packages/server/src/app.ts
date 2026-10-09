import { OpenAPIHono } from "@hono/zod-openapi";
import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import {
  type AdmissionLimits,
  type MetricSink,
  type ResolvedWarmPool,
  RuntimeMetrics,
  Scheduler,
  type SchedulerDeps,
  type Store,
  WarmPoolManager,
  type WorkspaceDriver,
  type WorkspaceSecretResolver,
  type WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";
import { registerAdministrationRoutes } from "./administration/administration-routes";
import { registerKeyRoutes } from "./administration/keys-routes";
import { registerPrincipalRoutes } from "./administration/principals-routes";
import { registerOperatorRecoveryRoutes } from "./administration/recovery-routes";
import { agentMessageBodyTransform, attachmentUploadHandler } from "./attachments/attachments";
import { createAgentApp } from "./control-channel/agent-app";
import { Hub } from "./control-channel/hub";
import { PoolConnectionHub } from "./control-channel/pool-ws";
import { registerConversationRoutes } from "./conversations/conversations-routes";
import { type AppEnv, errorHandler, machineAuth, requestId, requestLogging, requireScope } from "./http/middleware";
import { registerDiagnosticRoutes } from "./observability/diagnostics-routes";
import { Readiness } from "./observability/health";
import { createStructuredLogger, type StructuredLogger } from "./observability/observability";
import { type CheckpointTransferOptions, composeCheckpointRuntime } from "./persistence/checkpoint-runtime";
import { registerCheckpointRoutes } from "./persistence/checkpoints-routes";
import { type PersistenceLimits, PersistenceService } from "./persistence/persistence";
import { registerPurgeRoutes } from "./persistence/purge-routes";
import { registerRecoveryRoutes } from "./persistence/recovery-routes";
import { kubernetesSourceRuntime } from "./persistence/source-runtime";
import { relayHandler } from "./relay/relay";
import { createIssuerClient } from "./secrets/issuer-client";
import { createWorkspaceLeaseService } from "./secrets/lease-service";
import { registerSecretRoutes } from "./secrets/secret-routes";
import { createSecretVault } from "./secrets/secret-vault";
import { registerCatalogRoutes } from "./templates/catalog-routes";
import { terminalCallbacks } from "./terminals/terminal-audit";
import { terminalConnectValidator, terminalWsEvents } from "./terminals/terminal-ws";
import { WorkspaceService } from "./workspaces/service";
import { registerWorkspaceRoutes } from "./workspaces/workspaces-routes";

export interface BuildDeps {
  authorizeLaunch?: SchedulerDeps["authorizeLaunch"];
  store: Store;
  driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
  storageDriver?: WorkspaceStorageDriver;
  secretResolver?: WorkspaceSecretResolver;
  persistenceLimits?: PersistenceLimits;
  checkpointTransferOptions?: CheckpointTransferOptions;
  pepper: string;
  secretKey?: string;
  issuerClient?: ReturnType<typeof createIssuerClient>;
  eventSigningKey?: string;
  egressImage?: string | null;
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
  agentApp: ReturnType<typeof createAgentApp>;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
  hub: Hub;
  workspaceLeases?: ReturnType<typeof createWorkspaceLeaseService>;
  scheduler: Scheduler;
  service: WorkspaceService;
  persistence: PersistenceService;
  checkpointTransfers?: ReturnType<typeof composeCheckpointRuntime>["checkpointTransfers"];
  warmPool?: WarmPoolManager;
  metrics: MetricSink;
}

function workspaceSecretFactory(pepper: string) {
  return {
    generate: generateOpaqueSecret,
    digest: (secret: string) => digestOpaque(pepper, secret),
  };
}

function composeWorkspaceRuntime(deps: BuildDeps, hub: Hub) {
  const vault = deps.secretKey ? createSecretVault(deps.store, Buffer.from(deps.secretKey, "base64url")) : undefined;
  const workspaceLeases = vault
    ? createWorkspaceLeaseService({ store: deps.store, vault, issuer: deps.issuerClient ?? createIssuerClient() })
    : undefined;
  const checkpointRuntime = composeCheckpointRuntime(
    deps.store,
    hub,
    deps.driver,
    deps.storageDriver,
    deps.checkpointTransferOptions,
  );
  const { checkpointTransfers } = checkpointRuntime;
  const transferRuntime =
    checkpointRuntime.transferRuntime ??
    (deps.driver.kind === "kubernetes" && !deps.storageDriver ? kubernetesSourceRuntime() : undefined);
  return { workspaceLeases, checkpointTransfers, transferRuntime };
}

function registerHealthRoutes(app: OpenAPIHono<AppEnv>, deps: BuildDeps) {
  const readiness = deps.readiness ?? new Readiness();
  app.get("/livez", (c) =>
    c.json({
      ok: true,
      ...(deps.instanceId ? { instance_id: deps.instanceId } : {}),
    }),
  );
  app.get("/readyz", (c) => {
    const snapshot = readiness.snapshot();
    return c.json(
      {
        ...snapshot,
        ...(deps.instanceId ? { instance_id: deps.instanceId } : {}),
      },
      snapshot.ok ? 200 : 503,
    );
  });
}

export function buildServer(deps: BuildDeps): BuiltServer {
  const { store, driver, pepper, limits } = deps;
  const logger = deps.logger ?? createStructuredLogger(() => {});
  const metrics = deps.metrics ?? new RuntimeMetrics();
  const log = (message: string) => logger.info("runtime.message", { message });
  const hub = new Hub(terminalCallbacks(store));
  const { workspaceLeases, checkpointTransfers, transferRuntime } = composeWorkspaceRuntime(deps, hub);
  const poolHub = new PoolConnectionHub();
  const secretFactory = workspaceSecretFactory(pepper);
  const warmPool = deps.warmPools
    ? new WarmPoolManager({
        store,
        driver,
        connections: poolHub,
        secrets: secretFactory,
        workspaceServerUrl: deps.workspaceServerUrl,
        pools: deps.warmPools,
        onError: (context, error) => log(`${context}: ${String(error)}`),
      })
    : undefined;
  const persistenceHolder: { service?: PersistenceService } = {};
  const scheduler = new Scheduler({
    ...(deps.authorizeLaunch ? { authorizeLaunch: deps.authorizeLaunch } : {}),
    store,
    driver,
    ...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
    ...(transferRuntime ? { transferRuntime } : {}),
    ...(deps.secretResolver ? { secretResolver: deps.secretResolver } : {}),
    ...(workspaceLeases ? { revokeWorkspaceLeases: workspaceLeases.revokeWorkspace } : {}),
    connections: hub,
    secrets: secretFactory,
    limits,
    workspaceServerUrl: deps.workspaceServerUrl,
    metrics,
    ...(warmPool ? { warmPool } : {}),
    preserveByPolicy: async (row, trigger) => persistenceHolder.service?.preserveByPolicy(row, trigger) ?? false,
    onError: (context, err) => log(`scheduler ${context}: ${String(err)}`),
  });
  const service = new WorkspaceService({ store, scheduler, limits });
  const persistence = new PersistenceService({
    store,
    scheduler,
    driver,
    ...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
    ...(checkpointTransfers ? { checkpointTransfers } : {}),
    hub,
    workspaces: service,
    maxQueuedWorkspaces: limits.maxQueuedWorkspaces,
    log,
    ...(deps.persistenceLimits ? { limits: deps.persistenceLimits } : {}),
  });
  persistenceHolder.service = persistence;

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        if (issue?.path.some((segment) => String(segment).toLowerCase() === "idempotency-key")) {
          throw new ApiError("validation.invalid", "Idempotency-Key header is required.");
        }
        throw new ApiError(
          "validation.invalid",
          issue ? `${issue.path.join(".") || "request"}: ${issue.message}` : "Invalid request.",
        );
      }
    },
  });
  app.onError(errorHandler(logger));
  app.use("*", requestId);
  app.use("*", requestLogging(logger));

  registerHealthRoutes(app, deps);

  // Agent supervisor connection; authenticated by registration/reconnect
  // credentials, not machine keys, so it is registered before machineAuth.
  const wsDeps = {
    ...(workspaceLeases ? { workspaceLeases } : {}),
    store,
    hub,
    scheduler,
    pepper,
    cleanupInput: driver.cleanupInput?.bind(driver),
    log,
    persistence,
    ...(checkpointTransfers ? { checkpointTransfers } : {}),
  };
  const agentApp = createAgentApp({
    connection: wsDeps,
    poolHub,
    ...(checkpointTransfers ? { checkpointTransfers } : {}),
    warmPool,
    eventSigningKey: deps.eventSigningKey ?? pepper,
    logger,
    upgradeWebSocket,
  });
  app.all("/v1/agent/*", (c) => c.notFound());
  app.all("/v1/internal/*", (c) => c.notFound());

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

  if (deps.secretKey) registerSecretRoutes(app, createSecretVault(store, Buffer.from(deps.secretKey, "base64url")));
  registerCatalogRoutes({ app, store, egressImage: deps.egressImage });
  registerPrincipalRoutes(app, store);
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
    upgradeWebSocket(terminalWsEvents(terminalDeps)),
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
    agentApp,
    websocket,
    hub,
    ...(workspaceLeases ? { workspaceLeases } : {}),
    scheduler,
    service,
    persistence,
    metrics,
    ...(checkpointTransfers ? { checkpointTransfers } : {}),
    ...(warmPool ? { warmPool } : {}),
  };
}
