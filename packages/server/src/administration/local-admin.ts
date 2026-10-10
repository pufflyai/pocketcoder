import { ApiError, KeyIssueRequestSchema } from "@pstdio/pocketcoder-contracts";
import { bootstrapLocalOwnerKey, type Store } from "@pstdio/pocketcoder-runtime-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type ControllerBackup, registerBackupRoute } from "../backup/controller-backup";
import { startAdminSocket } from "./admin-socket";
import { registerUsageRuntimeRoute } from "./usage-runtime";

const OwnerRequestSchema = z.strictObject({
  name: z.literal("owner").default("owner"),
  request_id: KeyIssueRequestSchema.shape.request_id,
  expires_at: KeyIssueRequestSchema.shape.expires_at.optional(),
  automation: z.boolean().optional(),
  replace: z.boolean().optional(),
});
export async function startLocalAdmin(deps: {
  directory: string;
  store: Store;
  pepper: string;
  backup: ControllerBackup;
}) {
  const app = new Hono();
  const store = deps.store;
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (context) => context.json({ error: "body too large" }, 413) }));
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
  registerUsageRuntimeRoute(app, store);
  // The controller retains its writer lock until these handlers have settled.
  return startAdminSocket(deps.directory, app.fetch);
}
