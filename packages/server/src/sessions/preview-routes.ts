import type { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError, PreviewNameSchema, ViewSessionSchema } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";
import { managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";
import type { composePreviews } from "../previews/previews";

type PreviewOwners = Pick<ReturnType<typeof composePreviews>, "grants" | "sessions" | "mintUrl">;

const SessionPreviewOpenSchema = z
  .strictObject({
    session: ViewSessionSchema.default({ mode: "local" }),
    grant: z
      .strictObject({
        id: z.uuid(),
        subject: z.string().min(1).max(256),
        accessRevision: z.string().min(1).max(256),
        ceilingAt: z.iso.datetime(),
      })
      .optional(),
  })
  .refine((input) => input.session.mode === "local" || input.grant !== undefined, "Cloud previews require a grant");

// Applications open a preview by logical session. The controller resolves the current binding,
// creates the grant against that exact workspace incarnation and refuses the open if the binding
// changed meanwhile, so a returned URL never points at compute the session no longer owns.
export function registerSessionPreviewRoutes(app: OpenAPIHono<AppEnv>, store: Store, previews: PreviewOwners) {
  app.use("/v1/sessions/:sessionId/previews/:name", managedBodyLimit(16384));
  app.post("/v1/sessions/:sessionId/previews/:name", requireScope("previews:open"), async (c) => {
    const keyId = c.get("keyId");
    const sessionId = z.uuid().parse(c.req.param("sessionId"));
    const name = PreviewNameSchema.safeParse(c.req.param("name"));
    const parsed = SessionPreviewOpenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!name.success || !parsed.success) throw new ApiError("validation.invalid", "Invalid session preview request.");
    const input = parsed.data;
    const before = await store.managed.sessions.binding(keyId, sessionId);
    const workspace = before && (await store.getWorkspace(before.workspaceId));
    if (
      !before ||
      !workspace ||
      workspace.state !== "ready" ||
      workspace.runtimeRegistration?.incarnationId !== before.incarnationId
    )
      throw new ApiError("workspace.not_ready", "The session has no ready compute.");
    const grantId = input.grant
      ? (await previews.grants.create(workspace, keyId, { ...input.grant, previews: [name.data] })).grant.id
      : undefined;
    const url = previews.mintUrl(c, workspace.id, name.data, input.session);
    const minted = await previews.sessions.mint(
      workspace.id,
      name.data,
      url.origin,
      keyId,
      false,
      input.session,
      grantId,
    );
    const after = await store.managed.sessions.binding(keyId, sessionId);
    if (after?.bindingRevision !== before.bindingRevision) {
      // The grant is bound to the old incarnation; revoke it instead of returning a stale URL.
      if (grantId) {
        await store.previewGrants.revoke(grantId, new Date());
        previews.sessions.closeGrant(grantId);
      }
      throw new ApiError("operation.conflict", "Session compute changed; open again with a new grant id.");
    }
    url.searchParams.set("token", minted.token);
    c.header("cache-control", "no-store");
    return c.json({ url: url.href, expires_at: new Date(minted.expires).toISOString(), grantId: grantId ?? null }, 201);
  });
}
