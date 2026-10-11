import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AgentInterruptResponseSchema, ApiError, findRoute } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { assertRelayReady, type RelayDeps, relayBuffered } from "./relay";

// Calls AgentAPI through the same template route allowlist as the relay.
async function callAgent(deps: RelayDeps, row: WorkspaceRow, method: "GET" | "POST", path: string, body?: unknown) {
  const match = findRoute(row.templateSnapshot, "agent", method, path);
  if (!match) {
    throw new ApiError("relay.route_not_allowed", `${method} ${path} is not declared by this template.`);
  }
  const response = await relayBuffered(
    deps,
    row.id,
    {
      service: "agent",
      method,
      path,
      query: {},
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body_b64: Buffer.from(JSON.stringify(body)).toString("base64") }),
      deadline_ms: match.route.deadlineSeconds * 1000,
    },
    match.route.maxResponseBytes,
  );
  if (response.status >= 300) {
    throw new ApiError("relay.upstream_error", `The workspace answered ${method} ${path} with ${response.status}.`);
  }
  return JSON.parse(response.body.toString()) as Record<string, unknown>;
}

export function registerAgentInterruptRoute(app: OpenAPIHono<AppEnv>, deps: RelayDeps) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces/{id}/agent/interrupt",
      operationId: "interruptAgentTurn",
      tags: ["Workspaces"],
      middleware: [requireScope("services:relay")] as const,
      request: {
        params: z.object({ id: z.uuid() }),
      },
      responses: {
        200: {
          description: "Whether interrupt keys were sent to the running agent",
          content: { "application/json": { schema: AgentInterruptResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await deps.service.getOwned(c.get("principal"), id);
      assertRelayReady(row);
      const keys = row.templateSnapshot.spec.agent?.interruptKeys;
      if (!keys) {
        throw new ApiError("agent.interrupt_unsupported", "This workspace's agent does not support interruption.");
      }
      // AgentAPI has no turn ID, so status is the only guard against sending
      // keys to an agent waiting for input. It still reports running until the
      // screen has been still for 2 s, so templates must make a stray key
      // harmless.
      const { status } = await callAgent(deps, row, "GET", "/status");
      if (status !== "running") return c.json({ status: "idle" as const }, 200);
      await callAgent(deps, row, "POST", "/message", { type: "raw", content: keys });
      return c.json({ status: "requested" as const }, 200);
    },
  );
}
