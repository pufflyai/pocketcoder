// Composes concrete controller service ownership and worker dispatch.
import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import {
  RuntimeOperations as ControllerOperations,
  RuntimeMetrics,
  Scheduler,
  WarmPoolManager,
} from "@pstdio/pocketcoder-runtime-core";
import type { BuildDeps } from "../app";
import { Hub } from "../control-channel/hub";
import { PoolConnectionHub } from "../control-channel/pool-ws";
import { createStructuredLogger } from "../observability/observability";
import { PersistenceService } from "../persistence/persistence";
import { terminalCallbacks } from "../terminals/terminal-audit";
import { WorkspaceService } from "../workspaces/service";
import { ownControllerServices } from "./controller-services";

function workspaceSecretFactory(pepper: string) {
  return {
    generate: generateOpaqueSecret,
    digest: (secret: string) => digestOpaque(pepper, secret),
  };
}

export function buildControllerRuntime(deps: BuildDeps) {
  const { pepper, limits } = deps;
  const operations = new ControllerOperations();
  const { store, driver, storageDriver, secretResolver } = ownControllerServices(deps, operations);
  const logger = deps.logger ?? createStructuredLogger(() => {});
  const metrics = deps.metrics ?? new RuntimeMetrics();
  const log = (message: string) => logger.info("runtime.message", { message });
  const callbacks = terminalCallbacks(store);
  const hub = new Hub({
    onTerminalInput: callbacks.onTerminalInput,
    onTerminalClosed: (event) =>
      operations.run(async () => {
        await callbacks.onTerminalClosed?.(event);
      }),
  });
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
    operations,
    ...(deps.authorizeLaunch ? { authorizeLaunch: deps.authorizeLaunch } : {}),
    store,
    driver,
    ...(storageDriver ? { storageDriver } : {}),
    ...(secretResolver ? { secretResolver } : {}),
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
    operations,
    store,
    scheduler,
    driver,
    ...(storageDriver ? { storageDriver } : {}),
    hub,
    workspaces: service,
    maxQueuedWorkspaces: limits.maxQueuedWorkspaces,
    log,
    ...(deps.persistenceLimits ? { limits: deps.persistenceLimits } : {}),
  });
  persistenceHolder.service = persistence;

  return {
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
  };
}
