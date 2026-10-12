import type { OpenAPIHono } from "@hono/zod-openapi";
import { agentMessageBodyTransform, attachmentUploadHandler } from "../attachments/attachments";
import { type AppEnv, requireScope } from "../http/middleware";
import { registerAgentInterruptRoute } from "./agent-interrupt";
import { type RelayDeps, relayHandler } from "./relay";

export function registerRelayRoutes(app: OpenAPIHono<AppEnv>, deps: RelayDeps) {
  app.put(
    "/v1/workspaces/:id/attachments/:attachmentId",
    requireScope("attachments:write"),
    attachmentUploadHandler(deps),
  );

  // Registered before the wildcard relay routes so they take precedence: the
  // interrupt action, and the message aliases that resolve attachment
  // references on both spellings.
  registerAgentInterruptRoute(app, deps);
  const messageTransform = agentMessageBodyTransform(deps);
  app.post(
    "/v1/workspaces/:id/agent/message",
    requireScope("services:relay"),
    relayHandler(deps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
      transformBodyB64: messageTransform,
    }),
  );
  app.post(
    "/v1/workspaces/:id/services/agent/message",
    requireScope("services:relay"),
    relayHandler(deps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/services/agent`,
      transformBodyB64: messageTransform,
    }),
  );
  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/v1/workspaces/:id/services/:service/*",
    requireScope("services:relay"),
    relayHandler(deps),
  );
  app.on(
    ["GET", "POST"],
    "/v1/workspaces/:id/agent/*",
    requireScope("services:relay"),
    relayHandler(deps, {
      service: "agent",
      pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
    }),
  );
}
