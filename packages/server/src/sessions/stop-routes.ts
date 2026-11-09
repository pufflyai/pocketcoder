import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ExecutionDispatcher, ManagedStopResult, Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES, managedBodyLimit } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

const sessionParams = z.object({ sessionId: z.uuid() });
const receipts = {
  200: {
    description: "Stop completed",
    content: { "application/json": { schema: managed.CancelReceiptSchema } },
  },
  202: {
    description: "Stop accepted and still pending",
    content: { "application/json": { schema: managed.CancelReceiptSchema } },
  },
  ...MANAGED_ERROR_RESPONSES,
};
const body = { content: { "application/json": { schema: managed.CancelCommandSchema } } };

// Cancel and close persist one stop command, then hand running work to the existing targeted-cancel lane.
export function registerSessionStopRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    store: Store;
    executionDispatcher: Pick<ExecutionDispatcher, "cancel" | "tick">;
    stopSeconds?: number;
  },
) {
  const { store, executionDispatcher } = deps;
  const base = "/v1/sessions/{sessionId}";
  app.use("/v1/sessions/:sessionId/close", managedBodyLimit(1024));
  app.use("/v1/sessions/:sessionId/requests/:requestId/cancel", managedBodyLimit(1024));
  const windowMs = () => {
    if (!deps.stopSeconds)
      throw new ApiError("runtime.unavailable", "Explicit session stop deadlines are not configured.");
    return deps.stopSeconds * 1000;
  };
  const dispatch = (result: ManagedStopResult) => {
    for (const record of result.executions) executionDispatcher.cancel(record);
    void executionDispatcher.tick();
  };
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/requests/{requestId}/cancel`,
      tags: ["Managed sessions"],
      operationId: "cancelManagedRequest",
      middleware: [requireScope("sessions:write")] as const,
      request: { params: sessionParams.extend({ requestId: z.uuid() }), body },
      responses: receipts,
    }),
    async (c) => {
      const { sessionId, requestId } = c.req.valid("param");
      const result = await store.managed.requests.cancel(
        c.get("keyId"),
        sessionId,
        requestId,
        c.req.valid("json"),
        windowMs(),
        new Date(),
      );
      dispatch(result);
      return c.json(result.receipt, result.receipt.state === "completed" ? 200 : 202);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/close`,
      tags: ["Managed sessions"],
      operationId: "closeManagedSession",
      middleware: [requireScope("sessions:write")] as const,
      request: { params: sessionParams, body },
      responses: receipts,
    }),
    async (c) => {
      const result = await store.managed.sessions.close(
        c.get("keyId"),
        c.req.valid("param").sessionId,
        c.req.valid("json"),
        windowMs(),
        new Date(),
      );
      // The placement owner stops compute this session owns alone, also after a controller restart.
      dispatch(result);
      return c.json(result.receipt, result.receipt.state === "completed" ? 200 : 202);
    },
  );
}
