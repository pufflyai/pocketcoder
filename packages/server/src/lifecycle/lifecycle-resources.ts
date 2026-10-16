import { readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type DatabaseOpenOptions, PGliteStore } from "@pstdio/pocketcoder-db";
import {
  type AccountPurgeReader,
  createAccountPurgeReader,
  loadAccountPurgeReader,
  loadOffNodeConfig,
  type OffNode,
} from "@pstdio/pocketcoder-db/off-node";
import {
  DockerDriver,
  FileSecretResolver,
  FilesystemStorageDriver,
  KubernetesDriver,
  KubernetesSecretResolver,
  KubernetesSharedStorage,
  type RegistryResolver,
} from "@pstdio/pocketcoder-drivers";
import {
  type DiscoveredProvider,
  loadTemplateDir,
  type RuntimeMetrics,
  reconcilePersistence,
  reconcileProviders,
  type Store,
  type WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-core";
import { openControllerStore } from "../bootstrap/controller-store";
import type { ServerConfig } from "../config/config";
import { AccountPurgeRequiredError } from "../maintenance/account-purge";
import { loadPurgeState } from "../maintenance/purge-state";
import type { CheckpointTransferService } from "../persistence/checkpoint-transfer";
import { createIssuerClient } from "../secrets/issuer-client";
import { dockerInputProjectionOptions } from "./input-storage-config";
import type { ServerLog } from "./lifecycle";

async function initializeStore(
  config: ServerConfig,
  log: ServerLog,
  offNode?: OffNode,
  beforeOpen?: DatabaseOpenOptions["beforeOpen"],
) {
  const store = await PGliteStore.create(config.dataDir, {
    ...(config.journalDir ? { journalDir: config.journalDir } : {}),
    ...(offNode ? { acknowledgeJournal: offNode.journal.acknowledge } : {}),
    ...(beforeOpen ? { beforeOpen } : {}),
  });
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

export function createWorkspaceDriver(
  config: ServerConfig,
  resolveRegistry?: RegistryResolver,
  sharedStorage?: KubernetesSharedStorage,
) {
  const egress = {
    ...(resolveRegistry ? { resolveRegistry } : {}),
    ...(config.egressImage ? { egressImage: config.egressImage } : {}),
    egressSigningKey: config.eventSigningKey,
  };
  if (config.driverKind === "kubernetes") {
    if (config.inputStorage?.projection) throw new Error("Daemon-host input projection is supported by Docker only.");
    return new KubernetesDriver({
      ...(config.kubernetesSharedStorage
        ? { sharedStorage: sharedStorage ?? new KubernetesSharedStorage(config.kubernetesSharedStorage) }
        : {}),
      ...egress,
      namespace: config.kubernetesNamespace,
      captureTerminationEvidence: true,
      nodeSelector: config.kubernetesNodeSelector ?? undefined,
      tolerations: config.kubernetesTolerations,
      runtimeClassName: config.kubernetesRuntimeClass ?? undefined,
      ...(config.kubernetesServiceAccount ? { serviceAccountName: config.kubernetesServiceAccount } : {}),
    });
  }
  return new DockerDriver({
    ...(config.inputDir ? { inputDir: config.inputDir } : {}),
    inputProjection: dockerInputProjectionOptions(config),
    ...egress,
  });
}

export function createStorageDriver(config: ServerConfig) {
  if (config.kubernetesSharedStorage) return new KubernetesSharedStorage(config.kubernetesSharedStorage);
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
  discover?: () => Promise<DiscoveredProvider[] | undefined>,
): Promise<boolean> {
  try {
    await reconcileProviders({
      store,
      driver,
      ...(storageDriver ? { storageDriver } : {}),
      log,
      metrics,
      ...(discover ? { discover } : {}),
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

async function controllerResources(config: ServerConfig) {
  if (config.offNodeConfigFile && config.purgeConfigFile)
    throw new Error("Off-node accounts must use their existing purge identity, without a second purge config.");
  const offNode = config.offNodeConfigFile
    ? await loadOffNodeConfig(config.offNodeConfigFile, config.dataDir)
    : undefined;
  let accountPurge: AccountPurgeReader | undefined;
  if (offNode)
    accountPurge = createAccountPurgeReader({
      accountId: offNode.config.accountId,
      createRequestDigest: offNode.config.createRequestDigest,
      storage: offNode.config.storage,
    });
  else if (config.purgeConfigFile) accountPurge = await loadAccountPurgeReader(config.purgeConfigFile, config.dataDir);
  return { offNode, accountPurge };
}

export async function initializeController(
  config: ServerConfig,
  log: ServerLog,
  beforeOpen?: DatabaseOpenOptions["beforeOpen"],
) {
  const resources = await controllerResources(config);
  // Neither normal admission nor a fresh database may return after permanent intent.
  if ((await resources.accountPurge?.()) || (await loadPurgeState(config.dataDir)))
    throw new AccountPurgeRequiredError();
  return openConfiguredController(config, log, resources, beforeOpen);
}

export async function initializePurgingController(config: ServerConfig, log: ServerLog) {
  const resources = await controllerResources(config);
  if (!resources.accountPurge || !(await resources.accountPurge()))
    throw new Error("Private cleanup requires permanent purge authority.");
  if (await resources.accountPurge.completed()) throw new Error("Account purge is complete.");
  if (!(await lstat(join(config.dataDir, "db"))).isDirectory())
    throw new Error("Private cleanup requires existing account data.");
  return openConfiguredController(config, log, resources);
}

async function openConfiguredController(
  config: ServerConfig,
  log: ServerLog,
  { offNode, accountPurge }: Awaited<ReturnType<typeof controllerResources>>,
  beforeOpen?: DatabaseOpenOptions["beforeOpen"],
) {
  if (config.pepper)
    return {
      config,
      store: await initializeStore(config, log, offNode, beforeOpen),
      directory: await realpath(config.dataDir),
      offNode,
      accountPurge,
    };
  const controller = await openControllerStore(config.dataDir, config.journalDir ?? undefined, {
    ...(offNode ? { acknowledgeJournal: offNode.journal.acknowledge } : {}),
    ...(beforeOpen ? { beforeOpen } : {}),
  });
  if (
    offNode &&
    Object.values(controller.keys).some((key) => Buffer.from(key, "base64url").equals(offNode.encryptionKey))
  ) {
    await controller.store.close();
    throw new Error("Off-node encryption key must differ from the controller key bundle.");
  }
  return {
    config: { ...config, ...controller.keys },
    store: controller.store,
    directory: controller.dataDirectory,
    // Only bundle keys are exact 32-byte files that a backup can carry unchanged.
    keyBundle: controller.keys,
    offNode,
    accountPurge,
  };
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

export function configuredIssuer(config: ServerConfig) {
  return createIssuerClient(config.issuerCaFile ? { ca: readFileSync(config.issuerCaFile, "utf8") } : {});
}
