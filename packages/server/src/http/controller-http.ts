// Creates HTTP admission, error handling and local controller health routes.
import { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { RuntimeOperations as ControllerOperations } from "@pstdio/pocketcoder-runtime-core";
import { Readiness } from "../observability/health";
import type { StructuredLogger } from "../observability/observability";
import { type AppEnv, errorHandler, requestId, requestLogging } from "./middleware";

export function createControllerHttp(
  operations: ControllerOperations,
  logger: StructuredLogger,
  options: { readiness?: Readiness; instanceId?: string },
) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        if (issue?.path.some((segment) => String(segment).toLowerCase() === "idempotency-key")) {
          throw new ApiError("validation.invalid", "Idempotency-Key header is required.");
        }
        throw new ApiError(
          "validation.invalid",
          issue ? `${issue.path.join(".") || "request"}: ${issue.message}` : "Invalid request.",
        );
      }
    },
  });
  app.onError(errorHandler(logger));
  app.use("*", requestId);
  app.use("*", requestLogging(logger));
  app.use("/v1/*", async (_c, next) => operations.run(next));

  const readiness = options.readiness ?? new Readiness();
  app.get("/livez", (c) =>
    c.json({
      ok: true,
      ...(options.instanceId ? { instance_id: options.instanceId } : {}),
    }),
  );
  app.get("/readyz", (c) => {
    const snapshot = readiness.snapshot();
    return c.json(
      {
        ...snapshot,
        ...(options.instanceId ? { instance_id: options.instanceId } : {}),
      },
      snapshot.ok ? 200 : 503,
    );
  });

  return app;
}
