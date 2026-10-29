import { signEvent } from "@pstdio/pocketcoder-auth";
import { OutboxDispatcher, RuntimeMetrics, resolveWarmPools, type Store } from "@pstdio/pocketcoder-runtime-core";
import { startLocalAdmin } from "../administration/local-admin";
import { buildServer } from "../app";
import { composeBackups } from "../backup/backup-composition";
import { startManagedPrincipals } from "../bootstrap/managed-principals/startup";
import { configSummary, listenerOrigin, loadConfig, type ServerConfig } from "../config/config";
import { composeAccountLifecycle } from "../maintenance/account-composition";
import { AccountPurgeRequiredError, accountPurgeFence, requireNormalController } from "../maintenance/account-purge";
import { accountState } from "../maintenance/account-state";
import { createMaintenance } from "../maintenance/maintenance";
import { configuredPurgeCleanup } from "../maintenance/purge-cleanup";
import { controllerHealth } from "../observability/controller-health";
import { Readiness } from "../observability/health";
import { createStructuredLogger, type StructuredLogger } from "../observability/observability";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "../observability/server-timing";
import { createRegistryResolver } from "../secrets/registry-resolver";
import { createSecretVault } from "../secrets/secret-vault";
import { startBackgroundTimers } from "./background-timers";
import { checkpointTransferOptions } from "./checkpoint-transfer-config";
import { inputStorageOptions } from "./input-storage-config";
import { loadLaunchPolicy } from "./launch-policy";
import {
  configuredIssuer,
  createSecretResolver,
  createStorageDriver,
  createWorkspaceDriver,
  loadConfiguredTemplates,
  reconcileCheckpointPreserves,
  reconcileStartup,
  requireEgressImageForRestrictedTemplates,
} from "./lifecycle-resources";
import { loadPolicyReconciliation } from "./policy-reconciliation";
import { startPurgingController } from "./purging-controller";
import { RecoveryRequiredError, startRecoveryController } from "./recovery-controller";
import { screenshotOptions } from "./screenshot-config";
import { initializeStartupController } from "./startup-discovery";

export { RecoveryRequiredError, startRecoveryController };

import { reconcileSetupLeases } from "./setup-lease-reconciliation";

export type ServerLog = (message: string) => void;

export interface RunningPocketCoderServer {
  config: ServerConfig;
  url: string;
  agentUrl: string;
  stop(): Promise<void>;
}

const defaultLog: ServerLog = (message) => console.log(`[pocketcoder-server] ${message}`);

function cleanupState(pending: number) {
  return pending > 0 ? "pending" : "ok";
}

function serverOutbox(config: ServerConfig, store: Store, log: ServerLog, metrics: RuntimeMetrics) {
  return new OutboxDispatcher({
    store,
    sinkUrl: config.eventSinkUrl,
    sign: (timestamp, body) => signEvent(config.eventSigningKey, timestamp, body),
    onError: (context, error) => log(`${context}: ${String(error)}`),
    metrics,
  });
}

function logStartupCleanup(log: ServerLog) {
  try {
    log("startup cleanup started");
  } catch {
    // A broken sink must not replace the original error or interrupt owned cleanup.
  }
}

async function startupWarmPools(store: Store, config: ServerConfig, driver: ReturnType<typeof createWorkspaceDriver>) {
  const warmPools = await resolveWarmPools(store, config.warmPools, driver.kind, config.limits.globalActiveWorkspaces);
  const warmPoolContinuously =
    warmPools.length > 0 || (await store.listWarmPoolRuntimes()).some((runtime) => runtime.state !== "failed");
  return { warmPools, warmPoolContinuously };
}

// Templates and principals come from operator files; both must be in place before serving.
async function loadDeclaredState(config: ServerConfig, store: Store, log: ServerLog, logger: StructuredLogger) {
  await loadConfiguredTemplates(store, config.templateDir, log);
  await requireEgressImageForRestrictedTemplates(store, config);
  return startManagedPrincipals({ config: config.principals, store, pepper: config.pepper, logger });
}

export async function startPocketCoderServer(
  config: ServerConfig = loadConfig(),
  options: { log?: ServerLog; instanceId?: string } = {},
): Promise<RunningPocketCoderServer> {
  const log = options.log ?? defaultLog;
  const authorizeLaunch = loadLaunchPolicy(config.launchPolicy);
  const logger = createStructuredLogger((record) => log(JSON.stringify(record)));
  const metrics = new RuntimeMetrics();
  log(`config: ${JSON.stringify(configSummary(config))}`);
  const { initialized, discovery } = await initializeStartupController(config, log);
  config = initialized.config;
  const { store, directory } = initialized;
  let admin: Awaited<ReturnType<typeof startLocalAdmin>> | undefined;
  let agentServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    await requireNormalController(initialized);
    if (await store.recovery.recoveryState()) throw new RecoveryRequiredError();
    const assertAccountAllowed = initialized.accountPurge ? accountPurgeFence(initialized.accountPurge) : undefined;
    const maintenance = createMaintenance();
    const transferOptions = checkpointTransferOptions(config);
    await store.acknowledgeJournal();
    await store.acquireCoordinatorLease();
    const durableAccountState = await accountState(directory);
    if (durableAccountState.state.state !== "ready") maintenance.fence();
    log("coordinator lease acquired");
    // Open turns lived in the previous process; record them before producers reconnect.
    const interrupted = await store.recordInterruptedTurns(new Date());
    if (interrupted) log(`conversations: recorded ${interrupted} interrupted turns`);
    const managedPrincipals = await loadDeclaredState(config, store, log, logger);
    const resolveRegistry = config.secretKey
      ? createRegistryResolver(createSecretVault(store, Buffer.from(config.secretKey, "base64url")))
      : undefined;
    const storageDriver = createStorageDriver(config);
    const sharedStorage = storageDriver?.kind === "kubernetes-shared" ? storageDriver : undefined;
    const driver = createWorkspaceDriver(config, resolveRegistry, sharedStorage);
    const { warmPools, warmPoolContinuously } = await startupWarmPools(store, config, driver);
    const secretResolver = createSecretResolver(config);
    const readiness = new Readiness({ reconciliation: "pending" }, metrics);
    const policyReconciliation = loadPolicyReconciliation(store, config.launchPolicy);
    if (policyReconciliation) readiness.set("policy-reconciliation", "pending");
    const built = buildServer({
      assertAccountAllowed,
      publicViews: config.publicViews,
      screenshotOptions: screenshotOptions(config),
      inputStorageOptions: inputStorageOptions(config),
      issuerClient: configuredIssuer(config),
      ...(authorizeLaunch ? { authorizeLaunch } : {}),
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      ...(secretResolver ? { secretResolver } : {}),
      pepper: config.pepper,
      ...(config.secretKey ? { secretKey: config.secretKey } : {}),
      eventSigningKey: config.eventSigningKey,
      egressImage: config.egressImage,
      limits: config.limits,
      workspaceServerUrl: config.workspaceServerUrl,
      persistenceLimits: config.persistenceLimits,
      checkpointTransferOptions: transferOptions,
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      logger,
      metrics,
      warmPools,
      readiness,
      maintenance,
    });
    const { app, agentApp, websocket, scheduler, persistence, warmPool, workspaceLeases, screenshots } = built;
    // A backup waits for admitted background work as well as admitted requests.
    // Scheduler finalizers can start preserves, so the scheduler settles first.
    maintenance.settleWith(() => scheduler.drain());
    maintenance.settleWith(() => built.executionDispatcher.drain());
    maintenance.settleWith(() => persistence.drain());
    maintenance.settleWith(() => screenshots?.drain() ?? Promise.resolve());
    await store.binaryOutputs.prune(new Date());
    await built.inputs?.reconcile();

    const pendingSetup = await reconcileSetupLeases(store, workspaceLeases, scheduler, true);
    const pendingTransfers = await reconcileCheckpointPreserves(
      store,
      persistence.reconcileCheckpointOperation,
      built.checkpointTransfers,
      true,
    );
    readiness.set("cleanup", cleanupState(pendingSetup + pendingTransfers));
    readiness.set(
      "reconciliation",
      (await reconcileStartup(
        store,
        driver,
        storageDriver,
        log,
        metrics,
        persistence.reconcileCheckpointOperation,
        discovery.providers,
      ))
        ? "ok"
        : "failed",
    );
    const accountLifecycle = composeAccountLifecycle({
      state: durableAccountState,
      maintenance,
      store,
      driver,
      storageDriver,
      log,
      metrics,
      readiness,
      runtime: { scheduler, persistence, workspaceLeases, checkpointTransfers: built.checkpointTransfers },
    });

    const purgeCleanup = await configuredPurgeCleanup(initialized, driver, maintenance, built);

    const outbox = serverOutbox(config, store, log, metrics);

    const timers = startBackgroundTimers({
      config,
      managedPrincipals,
      maintenance,
      log,
      outbox,
      policyReconciliation,
      ...(warmPool && warmPoolContinuously ? { warmPool } : {}),
      store,
      scheduler,
      persistence,
      workspaceLeases,
      checkpointTransfers: built.checkpointTransfers,
      inputs: built.inputs,
      liveTurns: built.liveTurns,
      executionDispatcher: built.executionDispatcher,
      readiness,
      metrics,
    });

    let server: ReturnType<typeof Bun.serve>;
    try {
      admin = await startLocalAdmin({
        monitoring: () => controllerHealth({ store, hub: built.hub, directory, readiness }),
        purgeCleanup,
        accountPurge: initialized.accountPurge,
        assertAccountAllowed,
        directory: directory,
        store,
        pepper: config.pepper,
        principalsFile: config.principals?.file,
        accountLifecycle,
        maintenance,
        ...composeBackups(initialized, maintenance, transferOptions?.directory, durableAccountState),
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
      await timers.stop();
      throw error;
    }

    const url = listenerOrigin(config.listenHost, server.port);
    const agentUrl = listenerOrigin(config.agentHost, agentServer.port);
    log(`listening on ${url}`);
    log(`workspaces reach this server at ${config.workspaceServerUrl}`);
    const initialWarmPool = (warmPool ? maintenance.pausable(() => warmPool.reconcile())() : undefined)?.catch(
      (error) => log(`warm pool initial reconcile failed: ${String(error)}`),
    );

    let stopPromise: Promise<void> | null = null;
    return {
      config,
      url,
      agentUrl,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          log("shutting down");
          await timers.stop();
          await purgeCleanup?.drain();
          await accountLifecycle.drain();
          await screenshots?.close();
          await built.checkpointTransfers?.close();
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
    logStartupCleanup(log);
    await discovery.settle();
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
  const running = await startPocketCoderServer(config, options).catch((error) => {
    if (error instanceof AccountPurgeRequiredError) return startPurgingController(config, options);
    if (!(error instanceof RecoveryRequiredError)) throw error;
    return startRecoveryController(config, options);
  });
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
