import { signEvent } from "@pstdio/pocketcoder-auth";
import { OutboxDispatcher, RuntimeMetrics, resolveWarmPools } from "@pstdio/pocketcoder-runtime-core";
import { startLocalAdmin } from "../administration/local-admin";
import { buildServer } from "../app";
import { configSummary, listenerOrigin, loadConfig, type ServerConfig } from "../config/config";
import { Readiness } from "../observability/health";
import { createStructuredLogger } from "../observability/observability";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "../observability/server-timing";
import { checkpointTransferOptions } from "./checkpoint-transfer-config";
import { loadLaunchPolicy } from "./launch-policy";
import {
  createSecretResolver,
  createStorageDriver,
  createWorkspaceDriver,
  initializeController,
  loadConfiguredTemplates,
  reconcileStartup,
  requireEgressImageForRestrictedTemplates,
  startExclusiveTimer,
} from "./lifecycle-resources";
import { loadPolicyReconciliation } from "./policy-reconciliation";

export type ServerLog = (message: string) => void;

export interface RunningPocketCoderServer {
  config: ServerConfig;
  url: string;
  agentUrl: string;
  stop(): Promise<void>;
}

const defaultLog: ServerLog = (message) => console.log(`[pocketcoder-server] ${message}`);

export async function startPocketCoderServer(
  config: ServerConfig = loadConfig(),
  options: { log?: ServerLog; instanceId?: string } = {},
): Promise<RunningPocketCoderServer> {
  const log = options.log ?? defaultLog;
  const authorizeLaunch = loadLaunchPolicy(config.launchPolicy);
  const logger = createStructuredLogger((record) => log(JSON.stringify(record)));
  const metrics = new RuntimeMetrics();
  log(`config: ${JSON.stringify(configSummary(config))}`);
  const initialized = await initializeController(config, log);
  config = initialized.config;
  const { store, directory } = initialized;
  let admin: Awaited<ReturnType<typeof startLocalAdmin>> | undefined;
  let agentServer: ReturnType<typeof Bun.serve> | undefined;
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
      warmPools.length > 0 || (await store.listWarmPoolRuntimes()).some((runtime) => runtime.state !== "failed");
    const storageDriver = createStorageDriver(config);
    const secretResolver = createSecretResolver(config);
    const readiness = new Readiness({ reconciliation: "pending" }, metrics);
    const policyReconciliation = loadPolicyReconciliation(store, config.launchPolicy);
    if (policyReconciliation) readiness.set("policy-reconciliation", "pending");
    const { app, agentApp, websocket, scheduler, persistence, warmPool, checkpointTransfers } = buildServer({
      ...(authorizeLaunch ? { authorizeLaunch } : {}),
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      ...(secretResolver ? { secretResolver } : {}),
      pepper: config.pepper,
      eventSigningKey: config.eventSigningKey,
      egressImage: config.egressImage,
      limits: config.limits,
      workspaceServerUrl: config.workspaceServerUrl,
      persistenceLimits: config.persistenceLimits,
      checkpointTransferOptions: checkpointTransferOptions(config),
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
          const pendingPurges = await persistence.retryPurges();
          readiness.set("cleanup", pendingPurges > 0 ? "pending" : "ok");
          metrics.observe("purge.pending", pendingPurges);
          readiness.set("coordinator", "ok");
        } catch (error) {
          readiness.set("coordinator", "failed");
          throw error;
        }
      },
      "scheduler tick failed",
      log,
    );
    const outboxTimer = startExclusiveTimer(config.outboxIntervalMs, () => outbox.tick(), "outbox tick failed", log);
    const policyTimer = policyReconciliation
      ? startExclusiveTimer(
          config.schedulerIntervalMs,
          async () => {
            try {
              await policyReconciliation.tick();
              readiness.set("policy-reconciliation", "ok");
            } catch (error) {
              readiness.set("policy-reconciliation", "failed");
              throw error;
            }
          },
          "policy reconciliation failed",
          log,
        )
      : null;
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
      admin = await startLocalAdmin({
        directory: directory,
        store,
        pepper: config.pepper,
      });
      agentServer = Bun.serve({
        hostname: config.agentHost,
        port: config.agentPort,
        idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
        fetch: agentApp.fetch,
        websocket,
      });
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
      if (policyTimer) clearInterval(policyTimer);
      await policyReconciliation?.drain();
      if (warmPoolTimer) clearInterval(warmPoolTimer);
      throw error;
    }

    const url = listenerOrigin(config.listenHost, server.port);
    const agentUrl = listenerOrigin(config.agentHost, agentServer.port);
    log(`listening on ${url}`);
    log(`workspaces reach this server at ${config.workspaceServerUrl}`);
    const initialWarmPool = warmPool
      ?.reconcile()
      .catch((error) => log(`warm pool initial reconcile failed: ${String(error)}`));

    let stopPromise: Promise<void> | null = null;
    return {
      config,
      url,
      agentUrl,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          log("shutting down");
          clearInterval(schedulerTimer);
          clearInterval(outboxTimer);
          clearInterval(retentionTimer);
          if (policyTimer) clearInterval(policyTimer);
          await policyReconciliation?.drain();
          if (warmPoolTimer) clearInterval(warmPoolTimer);
          await checkpointTransfers?.close();
          await persistence.drain();
          await scheduler.drain();
          await server.stop(true);
          await agentServer?.stop(true);
          await admin?.stop();
          // Initial reconciliation still owns store queries after listen succeeds.
          await initialWarmPool;
          await store.close();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    await agentServer?.stop(true);
    await admin?.stop();
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
