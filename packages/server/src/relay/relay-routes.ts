import type { OpenAPIHono } from "@hono/zod-openapi";
import { attachmentUploadHandler } from "../attachments/attachments";
import { type AppEnv, requireScope } from "../http/middleware";
import { type RelayDeps, relayHandler } from "./relay";

export function registerRelayRoutes(app: OpenAPIHono<AppEnv>, deps: RelayDeps) {
  app.put(
    "/v1/workspaces/:id/attachments/:attachmentId",
    requireScope("attachments:write"),
    attachmentUploadHandler(deps),
  );
  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/v1/workspaces/:id/services/:service/*",
    requireScope("services:relay"),
    relayHandler(deps),
  );
}
