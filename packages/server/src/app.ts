import { OpenAPIHono } from "@hono/zod-openapi";
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
import { type ControlActivity, controlActivity } from "./control-channel/activity";
import { createAgentApp } from "./control-channel/agent-app";
import { Hub } from "./control-channel/hub";
import { PoolConnectionHub } from "./control-channel/pool-ws";
import { controlStore } from "./control-channel/store";
import { registerConversationRoutes } from "./conversations/conversations-routes";
import { composeDisplays } from "./displays/displays";
import { registerScreenshotRoutes } from "./displays/screenshot-routes";
import { createScreenshots, type ScreenshotOptions, type Screenshots } from "./displays/screenshots";
import { journalGate } from "./http/journal-gate";
import { type AppEnv, errorHandler, machineAuth, requestId, requestLogging, requireScope } from "./http/middleware";
import { accountPurgeGate } from "./maintenance/account-purge";
import { type Maintenance, maintenanceGate } from "./maintenance/maintenance";
import { registerDiagnosticRoutes } from "./observability/diagnostics-routes";
import { Readiness } from "./observability/health";
import { createStructuredLogger, type StructuredLogger } from "./observability/observability";
import type { CheckpointTransferOptions, composeCheckpointRuntime } from "./persistence/checkpoint-runtime";
import { registerCheckpointRoutes } from "./persistence/checkpoints-routes";
import { type PersistenceLimits, PersistenceService } from "./persistence/persistence";
import { registerPurgeRoutes } from "./persistence/purge-routes";
import { registerRecoveryRoutes } from "./persistence/recovery-routes";
import { ViewAdmission } from "./previews/admission";
import { composePreviews } from "./previews/previews";
import { ViewPolicy } from "./previews/view-policy";
import { registerRelayRoutes } from "./relay/relay-routes";
import type { createIssuerClient } from "./secrets/issuer-client";
import type { createWorkspaceLeaseService } from "./secrets/lease-service";
import { registerSecretRoutes } from "./secrets/secret-routes";
import { createSecretVault } from "./secrets/secret-vault";
import { registerCatalogRoutes } from "./templates/catalog-routes";
import { terminalCallbacks } from "./terminals/terminal-audit";
import { terminalConnectValidator, terminalWsEvents } from "./terminals/terminal-ws";
import { composeWorkspaceRuntime, workspaceSecretFactory } from "./workspace-runtime";
import { WorkspaceService } from "./workspaces/service";
import { registerWorkspaceRoutes } from "./workspaces/workspaces-routes";

export interface BuildDeps {
  assertAccountAllowed?: () => Promise<void>;
  screenshotOptions?: ScreenshotOptions;
  publicViews?: import("./config/public-views").PublicViewConfig;
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
  maintenance?: Maintenance;
}

export interface BuiltServer {
  controlActivity: ControlActivity;
  screenshots?: Screenshots;
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

function composeScreenshots(deps: BuildDeps, hub: Hub, service: WorkspaceService) {
  if (deps.screenshotOptions)
    return createScreenshots({ store: deps.store, hub, service, options: deps.screenshotOptions });
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
    admissionFenced: () => deps.maintenance?.fenced ?? false,
    ...(deps.authorizeLaunch ? { authorizeLaunch: deps.authorizeLaunch } : {}),
    store,
    driver,
    ...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
    ...(transferRuntime ? { transferRuntime } : {}),
    ...(deps.secretResolver ? { secretResolver: deps.secretResolver } : {}),
    revokeWorkspaceLeases: workspaceLeases?.revokeWorkspace,
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
  const screenshots = composeScreenshots(deps, hub, service);
  const persistence = new PersistenceService({
    store,
    revokeWorkspaceLeases: workspaceLeases?.revokeWorkspace,
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
  const views = new ViewAdmission();
  const viewPolicy = new ViewPolicy(deps.publicViews);
  const previews = composePreviews({ store, service, hub, views, policy: viewPolicy });
  const displays = composeDisplays({ store, service, hub, views, policy: viewPolicy });
  app.use("*", accountPurgeGate(deps.assertAccountAllowed));
  app.use("*", displays.browser);
  app.use("*", previews.browser);
  app.use("*", requestId);
  app.use("*", requestLogging(logger));

  registerHealthRoutes(app, deps);

  // Agent supervisor connection; authenticated by registration/reconnect
  // credentials, not machine keys, so it is registered before machineAuth.
  const activity = controlActivity(() => poolHub.fence());
  const wsDeps = {
    activity,
    assertAccountAllowed: deps.assertAccountAllowed,
    ...(workspaceLeases ? { workspaceLeases } : {}),
    store: controlStore(store, deps.assertAccountAllowed),
    hub,
    scheduler,
    pepper,
    cleanupInput: driver.cleanupInput?.bind(driver),
    log,
    persistence,
    ...(checkpointTransfers ? { checkpointTransfers } : {}),
  };
  const agentApp = createAgentApp({
    assertAccountAllowed: deps.assertAccountAllowed,
    connection: wsDeps,
    screenshots,
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
  app.use("/v1/*", journalGate(store));
  if (deps.maintenance) app.use("/v1/*", maintenanceGate(deps.maintenance));

  if (deps.secretKey) registerSecretRoutes(app, createSecretVault(store, Buffer.from(deps.secretKey, "base64url")));
  registerCatalogRoutes({ app, store, egressImage: deps.egressImage });
  registerPrincipalRoutes(app, store);
  registerKeyRoutes(app, store, pepper);
  registerOperatorRecoveryRoutes(app, store, persistence);
  registerAdministrationRoutes({ app, store, persistence, warmPool });
  registerCheckpointRoutes({ app, store, service, persistence });
  registerRecoveryRoutes({ app, store, service, persistence });
  registerPurgeRoutes(app, persistence);
  registerConversationRoutes({ app, store, service });
  registerWorkspaceRoutes({ app, store, service });
  previews.register(app);
  displays.register(app);
  registerScreenshotRoutes(app, { store, service, screenshots });
  registerDiagnosticRoutes({ app, store, service });
  const terminalDeps = { store, hub, service };
  app.get(
    "/v1/workspaces/:id/terminal",
    requireScope("terminal:attach"),
    terminalConnectValidator(terminalDeps),
    upgradeWebSocket(terminalWsEvents(terminalDeps)),
  );

  registerRelayRoutes(app, { store, hub, service });

  return {
    controlActivity: activity,
    app,
    screenshots,
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
