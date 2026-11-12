import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hono } from "hono";
import { reconcileManagedPrincipals } from "../bootstrap/managed-principals/managed-principals";
import { readPrincipalFile } from "../bootstrap/managed-principals/principal-file";
import { createStructuredLogger } from "../observability/observability";

// Local administration reads the mounted file for both planning and an immediate reconcile.
export function registerPrincipalPlan(app: Hono, deps: { store: Store; pepper: string; file: string }) {
  app.post("/v1/principals/reconcile", async (context) => {
    const file = await readPrincipalFile(deps.file);
    return context.json(
      await reconcileManagedPrincipals({ ...deps, file, dryRun: false, logger: createStructuredLogger(() => {}) }),
    );
  });
  app.get("/v1/principals/plan", async (context) => {
    const file = await readPrincipalFile(deps.file).catch((error) => {
      throw new ApiError("validation.invalid", error instanceof Error ? error.message : String(error));
    });
    const logger = createStructuredLogger(() => {});
    return context.json(await reconcileManagedPrincipals({ ...deps, file, dryRun: true, logger }));
  });
}
