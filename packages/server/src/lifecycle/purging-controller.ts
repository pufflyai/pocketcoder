import { ApiError } from "@pstdio/pocketcoder-contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { startAdminSocket } from "../administration/admin-socket";
import { registerPurgeAdmin } from "../administration/purge-admin";
import { registerPurgeKeyStatus } from "../administration/purge-key-status";
import { buildServer } from "../app";
import type { ServerConfig } from "../config/config";
import { createMaintenance } from "../maintenance/maintenance";
import { createPurgeCleanup } from "../maintenance/purge-cleanup";
import { createRegistryResolver } from "../secrets/registry-resolver";
import { createSecretVault } from "../secrets/secret-vault";
import type { ServerLog } from "./lifecycle";
import { configuredIssuer, createWorkspaceDriver, initializePurgingController } from "./lifecycle-resources";

export async function startPurgingController(config: ServerConfig, options: { log?: ServerLog } = {}) {
  const log = options.log ?? ((message: string) => console.log(`[pocketcoder-server] ${message}`));
  const initialized = await initializePurgingController(config, log);
  const { store, directory, accountPurge: read } = initialized;
  config = initialized.config;
  try {
    if (!read) throw new Error("Private cleanup has no account authority.");
    const maintenance = createMaintenance();
    maintenance.fence();
    const vault = config.secretKey ? createSecretVault(store, Buffer.from(config.secretKey, "base64url")) : undefined;
    const driver = createWorkspaceDriver(config, vault ? createRegistryResolver(vault) : undefined);
    const runtime = buildServer({
      store,
      driver,
      pepper: config.pepper,
      ...(config.secretKey ? { secretKey: config.secretKey } : {}),
      issuerClient: configuredIssuer(config),
      eventSigningKey: config.eventSigningKey,
      egressImage: config.egressImage,
      limits: config.limits,
      workspaceServerUrl: config.workspaceServerUrl,
      maintenance,
    });
    maintenance.settleWith(() => runtime.scheduler.drain());
    maintenance.settleWith(() => runtime.persistence.drain());
    const cleanup = await createPurgeCleanup({ directory, read, store, driver, maintenance, runtime });
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 16_384, onError: (context) => context.json({ error: "body too large" }, 413) }));
    app.onError((error, context) => {
      const failure =
        error instanceof ApiError ? error : new ApiError("account.purge_pending", "Account cleanup remains pending.");
      return context.json(
        { error: { code: failure.code, message: failure.message } },
        failure.status as ContentfulStatusCode,
      );
    });
    registerPurgeKeyStatus(app, store, read);
    registerPurgeAdmin(app, cleanup);
    app.all("*", () => {
      throw new ApiError("account.purged", "Only irreversible private cleanup remains available.");
    });
    const admin = await startAdminSocket(directory, app.fetch);
    log("account purge: only the private cleanup socket is open");
    return {
      async stop() {
        await admin.stop();
        await cleanup.drain();
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
