import { startAdminSocket } from "../administration/admin-socket";
import { recoveryAdmin } from "../administration/recovery-admin";
import { buildServer } from "../app";
import type { ServerConfig } from "../config/config";
import { completeRecovery } from "../recovery/complete-recovery";
import { createRegistryResolver } from "../secrets/registry-resolver";
import { createSecretVault } from "../secrets/secret-vault";
import { checkpointTransferOptions } from "./checkpoint-transfer-config";
import type { ServerLog } from "./lifecycle";
import {
  configuredIssuer,
  createSecretResolver,
  createStorageDriver,
  createWorkspaceDriver,
  initializeController,
} from "./lifecycle-resources";

export class RecoveryRequiredError extends Error {
  constructor() {
    super("This data folder is in recovery. Start it with pocketcoder serve, then run pocketcoder recovery complete.");
  }
}

// A restored controller opens only its private admin socket: no operator or agent listener,
// no timers and no admission, until recovery completes and the operator restarts it.
export async function startRecoveryController(config: ServerConfig, options: { log?: ServerLog } = {}) {
  const log = options.log ?? ((message: string) => console.log(`[pocketcoder-server] ${message}`));
  const initialized = await initializeController(config, log);
  config = initialized.config;
  const { store, directory } = initialized;
  try {
    const recovery = await store.recovery.recoveryState();
    if (!recovery) throw new Error("This data folder is not in recovery.");
    const vault = config.secretKey ? createSecretVault(store, Buffer.from(config.secretKey, "base64url")) : undefined;
    const driver = createWorkspaceDriver(config, vault ? createRegistryResolver(vault) : undefined);
    const storageDriver = createStorageDriver(config);
    const secretResolver = createSecretResolver(config);
    const runtime = buildServer({
      issuerClient: configuredIssuer(config),
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
      checkpointTransferOptions: checkpointTransferOptions(config),
    });
    const app = recoveryAdmin(recovery, async () => {
      const result = await completeRecovery({ store, driver, ...(storageDriver ? { storageDriver } : {}) }, runtime);
      log("recovery complete; restart pocketcoder serve to open service");
      return result;
    });
    const admin = await startAdminSocket(directory, app.fetch);
    log(`recovery ${recovery.recoveryId}: only the local admin socket is open`);
    return {
      recovery,
      async stop() {
        await admin.stop();
        await runtime.checkpointTransfers?.close();
        await runtime.persistence.drain();
        await runtime.scheduler.drain();
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
