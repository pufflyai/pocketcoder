import { ApiError, KeyIssueRequestSchema } from "@pstdio/pocketcoder-contracts";
import type { AccountPurgeReader } from "@pstdio/pocketcoder-db/off-node";
import { bootstrapLocalOwnerKey, type Store } from "@pstdio/pocketcoder-runtime-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type ControllerBackup, registerBackupRoute } from "../backup/controller-backup";
import type { OffNodeBackup } from "../backup/off-node-backup";
import type { AccountLifecycle } from "../maintenance/account-lifecycle";
import { accountPurgeGate } from "../maintenance/account-purge";
import type { Maintenance } from "../maintenance/maintenance";
import type { PurgeCleanup } from "../maintenance/purge-cleanup";
import type { OffNodeRecovery } from "../recovery/off-node-recovery";
import { startAdminSocket } from "./admin-socket";
import { registerPurgeAdmin } from "./purge-admin";
import { registerPurgeKeyStatus } from "./purge-key-status";
import { controllerRelease } from "./release";
import { registerUsageRuntimeRoute } from "./usage-runtime";

const OwnerRequestSchema = z.strictObject({
  name: z.literal("owner").default("owner"),
  request_id: KeyIssueRequestSchema.shape.request_id,
  expires_at: KeyIssueRequestSchema.shape.expires_at.optional(),
  automation: z.boolean().optional(),
  replace: z.boolean().optional(),
});
export async function startLocalAdmin(deps: {
  accountPurge?: AccountPurgeReader;
  purgeCleanup?: PurgeCleanup;
  assertAccountAllowed?: () => Promise<void>;
  directory: string;
  store: Store;
  pepper: string;
  backup: ControllerBackup;
  offNodeBackup?: OffNodeBackup;
  offNodeRecovery?: OffNodeRecovery;
  accountLifecycle?: AccountLifecycle;
  maintenance?: Maintenance;
}) {
  const app = new Hono();
  const store = deps.store;
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (context) => context.json({ error: "body too large" }, 413) }));
  if (deps.assertAccountAllowed) {
    const gate = accountPurgeGate(deps.assertAccountAllowed);
    for (const path of ["/v1/owner", "/v1/backup/*", "/v1/backup", "/v1/account/resume", "/v1/account/verify"])
      app.use(path, gate);
  }
  if (deps.maintenance) {
    const maintenance = deps.maintenance;
    app.use("/v1/owner", async (_context, next) => maintenance.admit(next, "request"));
  }
  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json(
        { error: { code: error.code, message: error.message } },
        error.status as ContentfulStatusCode,
      );
    }
    return context.json({ error: { code: "internal.error", message: "Local administration failed." } }, 500);
  });
  app.post("/v1/owner", async (context) => {
    const parsed = OwnerRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("validation.invalid", "Invalid owner request.");
    const input = parsed.data;
    if (input.automation && !input.expires_at) {
      throw new ApiError("validation.invalid", "Automation requires an explicit owner expiry.");
    }
    const owner = await store.getPrincipalByName(input.name);
    const [existing] = owner ? await store.listMachineKeys(owner.id, { limit: 1, requestId: input.request_id }) : [];
    const expiry =
      input.expires_at ?? existing?.expiresAt?.toISOString() ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = await bootstrapLocalOwnerKey(
      store,
      deps.pepper,
      { request_id: input.request_id, expires_at: expiry },
      input.replace,
    );
    return context.json(result, result.token ? 201 : 200);
  });
  registerBackupRoute(app, deps.backup);
  if (deps.offNodeRecovery) {
    const recovery = deps.offNodeRecovery;
    app.get("/v1/backup/restoration", async (context) => context.json(await recovery.status()));
  }
  if (deps.offNodeBackup) {
    const backup = deps.offNodeBackup;
    app.post("/v1/backup/off-node", async (context) => {
      const input = z.strictObject({ operation_id: z.uuid() }).safeParse(await context.req.json().catch(() => null));
      if (!input.success) throw new ApiError("validation.invalid", "Invalid off-node backup request.");
      try {
        return context.json(await backup(input.data.operation_id, context.req.raw.signal), 201);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("backup.failed", error instanceof Error ? error.message : String(error));
      }
    });
    app.post("/v1/backup/runtime-proof", async (context) => {
      const input = z.strictObject({ operation_id: z.uuid() }).parse(await context.req.json());
      return context.json(await backup.runtimeProof(input.operation_id));
    });
  }
  registerUsageRuntimeRoute(app, store);
  app.get("/v1/release", (context) => context.json(controllerRelease));
  if (deps.purgeCleanup) registerPurgeAdmin(app, deps.purgeCleanup);
  if (deps.accountPurge) registerPurgeKeyStatus(app, store, deps.accountPurge);
  if (deps.accountLifecycle) {
    const lifecycle = deps.accountLifecycle;
    app.get("/v1/account", (context) => context.json(lifecycle.status()));
    app.post("/v1/account/verify", async (context) => context.json(await lifecycle.verify()));
    for (const kind of ["suspend", "resume"] as const) {
      app.post(`/v1/account/${kind}`, async (context) => {
        const input = z.strictObject({ request_id: z.uuid() }).safeParse(await context.req.json().catch(() => null));
        if (!input.success) throw new ApiError("validation.invalid", "Invalid account lifecycle request.");
        return context.json(await lifecycle.perform(input.data.request_id, kind));
      });
    }
  }
  // The controller retains its writer lock until these handlers have settled.
  return startAdminSocket(deps.directory, app.fetch);
}
