import { signEvent } from "@pstdio/pocketcoder-auth";
import { PostgresStore } from "@pstdio/pocketcoder-db";
import {
  DockerDriver,
  FileSecretResolver,
  FilesystemStorageDriver,
  KubernetesDriver,
  KubernetesPvcStorageDriver,
  KubernetesSecretResolver,
} from "@pstdio/pocketcoder-drivers";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import {
  loadTemplateDir,
  OutboxDispatcher,
  RuntimeMetrics,
  reconcilePersistence,
  reconcileProviders,
  resolveWarmPools,
  type Store,
} from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "./app";
import { configSummary, loadConfig, type ServerConfig } from "./config";
import { Readiness } from "./health";
import { createStructuredLogger } from "./observability";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server-timing";

export type ServerLog = (message: string) => void;

export interface RunningPocketCoderServer {
  config: ServerConfig;
  url: string;
  stop(): Promise<void>;
}

const defaultLog: ServerLog = (message) => console.log(`[pocketcoder-server] ${message}`);

async function initializeStore(config: ServerConfig, log: ServerLog): Promise<Store> {
  const store: Store =
    config.storeKind === "postgres"
      ? new PostgresStore(config.databaseUrl as string, config.databaseSchema)
      : new MemoryStore();
  await store.init();
  log(
    `store: ${config.storeKind}${config.storeKind === "postgres" ? ` (schema ${config.databaseSchema})` : ""}`,
  );
  return store;
}

async function loadConfiguredTemplates(
  store: Store,
  templateDir: string | null,
  log: ServerLog,
): Promise<void> {
  if (!templateDir) return;
  const result = await loadTemplateDir(store, templateDir);
  for (const row of result.loaded) {
    log(`template loaded: ${row.name}@${row.version} (${row.digest.slice(0, 19)}...)`);
  }
  for (const error of result.errors) {
    console.error(`[pocketcoder-server] template error in ${error.file}: ${error.message}`);
  }
  if (result.errors.length > 0) {
    throw new Error("refusing to start with invalid template files");
  }
}

async function requireEgressImageForRestrictedTemplates(store: Store, config: ServerConfig) {
  const restricted = (await store.listTemplates(null)).some(
    (template) => template.status === "active" && template.spec.network.mode === "restricted",
  );
  if (restricted && !config.egressImage) {
    throw new Error(
      "POCKETCODER_EGRESS_IMAGE is required when an active template uses restricted networking",
    );
  }
}

function createWorkspaceDriver(config: ServerConfig) {
  const egress = {
    ...(config.egressImage ? { egressImage: config.egressImage } : {}),
    egressSigningKey: config.eventSigningKey,
  };
  if (config.driverKind === "kubernetes") {
    return new KubernetesDriver({
      ...egress,
      namespace: config.kubernetesNamespace,
      nodeSelector: config.kubernetesNodeSelector ?? undefined,
      tolerations: config.kubernetesTolerations,
      ...(config.kubernetesServiceAccount
        ? { serviceAccountName: config.kubernetesServiceAccount }
        : {}),
    });
  }
  return new DockerDriver({ ...(config.inputDir ? { inputDir: config.inputDir } : {}), ...egress });
}

function createStorageDriver(config: ServerConfig) {
  if (config.storageBackend === "kubernetes-pvc") {
    return new KubernetesPvcStorageDriver({
      workspaceRoot: config.workspaceDataDir as string,
      checkpointRoot: config.checkpointDir as string,
      workspaceClaimName: config.kubernetesWorkspaceClaim as string,
      workspaceClaimSubPath: config.kubernetesWorkspaceSubPath,
    });
  }
  if (config.storageBackend === "filesystem") {
    return new FilesystemStorageDriver({
      workspaceRoot: config.workspaceDataDir as string,
      checkpointRoot: config.checkpointDir as string,
    });
  }
  return undefined;
}

function createSecretResolver(config: ServerConfig) {
  if (config.secretProvider === "kubernetes") {
    return new KubernetesSecretResolver({ namespace: config.kubernetesNamespace });
  }
  if (config.secretProvider === "file") {
    return new FileSecretResolver({ root: config.secretRoot as string });
  }
  return undefined;
}

async function reconcileStartup(
  store: Store,
  driver: ReturnType<typeof createWorkspaceDriver>,
  storageDriver: ReturnType<typeof createStorageDriver>,
  log: ServerLog,
  metrics: RuntimeMetrics,
): Promise<boolean> {
  try {
    await reconcileProviders({
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      log,
      metrics,
    });
    await reconcilePersistence({ store, driver, storageDriver, log, metrics });
    return true;
  } catch (error) {
    log(`startup reconciliation failed: ${String(error)}`);
    return false;
  }
}

function startExclusiveTimer(
  intervalMs: number,
  task: () => Promise<void>,
  errorContext: string,
  log: ServerLog,
): ReturnType<typeof setInterval> {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    task()
      .catch((error) => log(`${errorContext}: ${String(error)}`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
}

export async function startPocketCoderServer(
  config: ServerConfig = loadConfig(),
  options: { log?: ServerLog; instanceId?: string } = {},
): Promise<RunningPocketCoderServer> {
  const log = options.log ?? defaultLog;
  const logger = createStructuredLogger((record) => log(JSON.stringify(record)));
  const metrics = new RuntimeMetrics();
  log(`config: ${JSON.stringify(configSummary(config))}`);
  const store = await initializeStore(config, log);
  try {
    await store.acquireCoordinatorLease();
    log("coordinator lease acquired");
    await loadConfiguredTemplates(store, config.templateDir, log);
    await requireEgressImageForRestrictedTemplates(store, config);
    const driver = createWorkspaceDriver(config);
    const warmPools = await resolveWarmPools(
      store,
      config.warmPools,
      driver.kind,
      config.limits.globalActiveWorkspaces,
    );
    const warmPoolContinuously =
      warmPools.length > 0 ||
      (await store.listWarmPoolRuntimes()).some((runtime) => runtime.state !== "failed");
    const storageDriver = createStorageDriver(config);
    const secretResolver = createSecretResolver(config);
    const readiness = new Readiness({ reconciliation: "pending" }, metrics);
    const { app, websocket, scheduler, persistence, warmPool } = buildServer({
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      ...(secretResolver ? { secretResolver } : {}),
      pepper: config.pepper,
      eventSigningKey: config.eventSigningKey,
      limits: config.limits,
      workspaceServerUrl: config.workspaceServerUrl,
      persistenceLimits: config.persistenceLimits,
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      logger,
      metrics,
      warmPools,
      readiness,
    });

    readiness.set(
      "reconciliation",
      (await reconcileStartup(store, driver, storageDriver, log, metrics)) ? "ok" : "failed",
    );

    const outbox = new OutboxDispatcher({
      store,
      sinkUrl: config.eventSinkUrl,
      sign: (timestamp, body) => signEvent(config.eventSigningKey, timestamp, body),
      onError: (context, error) => log(`${context}: ${String(error)}`),
      metrics,
    });

    const schedulerTimer = startExclusiveTimer(
      config.schedulerIntervalMs,
      async () => {
        try {
          await scheduler.tick();
          readiness.set("coordinator", "ok");
        } catch (error) {
          readiness.set("coordinator", "failed");
          throw error;
        }
      },
      "scheduler tick failed",
      log,
    );
    const outboxTimer = startExclusiveTimer(
      config.outboxIntervalMs,
      () => outbox.tick(),
      "outbox tick failed",
      log,
    );
    const warmPoolTimer =
      warmPool && warmPoolContinuously
        ? startExclusiveTimer(
            config.schedulerIntervalMs,
            () => warmPool.reconcile(),
            "warm pool reconciliation failed",
            log,
          )
        : null;
    const retentionTimer = startExclusiveTimer(
      60_000,
      async () => {
        const { deleted, skipped } = await persistence.pruneExpired();
        if (deleted > 0 || skipped > 0) {
          log(`retention: deleted=${deleted} skipped=${skipped}`);
        }
      },
      "retention sweep failed",
      log,
    );

    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: config.listenHost,
        port: config.listenPort,
        idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
        fetch: app.fetch,
        websocket,
      });
    } catch (error) {
      clearInterval(schedulerTimer);
      clearInterval(outboxTimer);
      clearInterval(retentionTimer);
      if (warmPoolTimer) clearInterval(warmPoolTimer);
      throw error;
    }

    const healthHost =
      config.listenHost === "0.0.0.0" || config.listenHost === "::"
        ? "127.0.0.1"
        : config.listenHost;
    const url = `http://${healthHost}:${server.port}`;
    log(`listening on http://${config.listenHost}:${server.port}`);
    log(`workspaces reach this server at ${config.workspaceServerUrl}`);
    if (warmPool)
      void warmPool
        .reconcile()
        .catch((error) => log(`warm pool initial reconcile failed: ${String(error)}`));

    let stopPromise: Promise<void> | null = null;
    return {
      config,
      url,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          log("shutting down");
          clearInterval(schedulerTimer);
          clearInterval(outboxTimer);
          clearInterval(retentionTimer);
          if (warmPoolTimer) clearInterval(warmPoolTimer);
          await server.stop(true);
          await store.close();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
}

export async function runPocketCoderServerUntilSignal(
  config: ServerConfig = loadConfig(),
  options: { log?: ServerLog; instanceId?: string } = {},
): Promise<void> {
  const running = await startPocketCoderServer(config, options);
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      running.stop().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
