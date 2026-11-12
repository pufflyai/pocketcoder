import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { ExecutionDispatcher, ManagedStopResult, Store } from "@pstdio/pocketcoder-runtime-core";
import { MANAGED_ERROR_RESPONSES } from "../http/managed-routes";
import { type AppEnv, requireScope } from "../http/middleware";

export function registerSessionStopRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { store: Store; executionDispatcher: Pick<ExecutionDispatcher, "cancel" | "tick"> },
) {
  const receipts = {
    200: { description: "Stop completed", content: { "application/json": { schema: managed.CancelReceiptSchema } } },
    202: { description: "Stop pending", content: { "application/json": { schema: managed.CancelReceiptSchema } } },
    ...MANAGED_ERROR_RESPONSES,
  };
  const dispatch = (result: ManagedStopResult) => {
    for (const record of result.executions) deps.executionDispatcher.cancel(record);
    void deps.executionDispatcher.tick();
  };
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sessions/{sessionId}/requests/{requestId}/cancel",
      tags: ["Managed sessions"],
      operationId: "cancelManagedRequest",
      middleware: [requireScope("sessions:write")] as const,
      request: { params: z.object({ sessionId: z.uuid(), requestId: z.uuid() }) },
      responses: receipts,
    }),
    async (c) => {
      const { sessionId, requestId } = c.req.valid("param");
      const result = await deps.store.managed.requests.cancel(c.get("keyId"), sessionId, requestId, new Date());
      dispatch(result);
      return c.json(result.receipt, result.receipt.state === "completed" ? 200 : 202);
    },
  );
  for (const operation of ["cancel", "close"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/v1/sessions/{sessionId}/${operation}`,
        tags: ["Managed sessions"],
        operationId: `${operation}ManagedSession`,
        middleware: [requireScope("sessions:write")] as const,
        request: { params: z.object({ sessionId: z.uuid() }) },
        responses: receipts,
      }),
      async (c) => {
        const result = await deps.store.managed.sessions[operation](
          c.get("keyId"),
          c.req.valid("param").sessionId,
          new Date(),
        );
        dispatch(result);
        return c.json(result.receipt, result.receipt.state === "completed" ? 200 : 202);
      },
    );
  }
}
