import { realpath } from "node:fs/promises";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import {
  DockerDriver,
  FileSecretResolver,
  FilesystemStorageDriver,
  KubernetesDriver,
  KubernetesPvcStorageDriver,
  KubernetesSecretResolver,
  type RegistryResolver,
} from "@pstdio/pocketcoder-drivers";
import {
  loadTemplateDir,
  type RuntimeMetrics,
  reconcilePersistence,
  reconcileProviders,
  type Store,
  type WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-core";
import { openControllerStore } from "../bootstrap/controller-store";
import type { ServerConfig } from "../config/config";
import type { CheckpointTransferService } from "../persistence/checkpoint-transfer";
import type { ServerLog } from "./lifecycle";

async function initializeStore(config: ServerConfig, log: ServerLog): Promise<Store> {
  const store = await PGliteStore.create(config.dataDir);
  await store.init();
  log(`store: pglite (${config.dataDir})`);
  return store;
}

export async function loadConfiguredTemplates(store: Store, templateDir: string | null, log: ServerLog): Promise<void> {
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

export async function requireEgressImageForRestrictedTemplates(store: Store, config: ServerConfig) {
  const restricted = (await store.listTemplates(null)).some(
    (template) => template.status === "active" && template.spec.network.mode === "restricted",
  );
  if (restricted && !config.egressImage) {
    throw new Error("POCKETCODER_EGRESS_IMAGE is required when an active template uses restricted networking");
  }
}

export function createWorkspaceDriver(config: ServerConfig, resolveRegistry?: RegistryResolver) {
  const egress = {
    ...(resolveRegistry ? { resolveRegistry } : {}),
    ...(config.egressImage ? { egressImage: config.egressImage } : {}),
    egressSigningKey: config.eventSigningKey,
  };
  if (config.driverKind === "kubernetes") {
    return new KubernetesDriver({
      ...egress,
      namespace: config.kubernetesNamespace,
      captureTerminationEvidence: Boolean(config.launchPolicy),
      nodeSelector: config.kubernetesNodeSelector ?? undefined,
      tolerations: config.kubernetesTolerations,
      ...(config.kubernetesServiceAccount ? { serviceAccountName: config.kubernetesServiceAccount } : {}),
    });
  }
  return new DockerDriver({ ...(config.inputDir ? { inputDir: config.inputDir } : {}), ...egress });
}

export function createStorageDriver(config: ServerConfig) {
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

export function createSecretResolver(config: ServerConfig) {
  if (config.secretProvider === "kubernetes") {
    return new KubernetesSecretResolver({ namespace: config.kubernetesNamespace });
  }
  if (config.secretProvider === "file") {
    return new FileSecretResolver({ root: config.secretRoot as string });
  }
  return undefined;
}

export async function reconcileStartup(
  store: Store,
  driver: ReturnType<typeof createWorkspaceDriver>,
  storageDriver: ReturnType<typeof createStorageDriver>,
  log: ServerLog,
  metrics: RuntimeMetrics,
  reconcileCheckpointOperation?: (operation: WorkspaceOperationRow) => Promise<boolean>,
): Promise<boolean> {
  try {
    await reconcileProviders({
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      log,
      metrics,
    });
    await reconcilePersistence({ store, driver, storageDriver, log, metrics, reconcileCheckpointOperation });
    return true;
  } catch (error) {
    log(`startup reconciliation failed: ${String(error)}`);
    return false;
  }
}

export function startExclusiveTimer(
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

export async function initializeController(config: ServerConfig, log: ServerLog) {
  if (config.pepper)
    return { config, store: await initializeStore(config, log), directory: await realpath(config.dataDir) };
  const controller = await openControllerStore(config.dataDir);
  return { config: { ...config, ...controller.keys }, store: controller.store, directory: controller.dataDirectory };
}

export async function reconcileCheckpointPreserves(
  store: Store,
  recover: (operation: WorkspaceOperationRow) => Promise<boolean>,
  transfers?: CheckpointTransferService,
  verifyComplete = false,
) {
  const pending = (await transfers?.reconcile(verifyComplete)) ?? 0;
  for (const operation of await store.listIncompleteOperations()) {
    if (operation.kind === "preserve" && operation.state === "running") await recover(operation);
  }
  return pending;
}
