import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { RecoveryState } from "@pstdio/pocketcoder-db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { completeRecovery } from "../recovery/complete-recovery";

type Completion = Awaited<ReturnType<typeof completeRecovery>>;

// The only routes a controller in recovery serves, on its private admin socket.
export function recoveryAdmin(recovery: RecoveryState, complete: () => Promise<Completion>) {
  const app = new Hono();
  let running: Promise<Completion> | undefined;
  let completed = false;
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (context) => context.json({ error: "body too large" }, 413) }));
  app.onError((error, context) => {
    const failure =
      error instanceof ApiError ? error : new ApiError("recovery.failed", error.message || "Recovery failed.");
    return context.json(
      { error: { code: failure.code, message: failure.message } },
      failure.status as ContentfulStatusCode,
    );
  });
  app.get("/v1/recovery", (context) =>
    context.json({
      mode: "recovery",
      complete: completed,
      recovery_id: recovery.recoveryId,
      snapshot_id: recovery.snapshotId,
      journal: recovery.journal,
    }),
  );
  app.post("/v1/recovery/complete", async (context) => {
    if (completed) throw new ApiError("recovery.failed", "Recovery is complete. Restart pocketcoder serve.");
    // One completion runs at a time; a concurrent caller waits for the same result.
    running ??= complete().finally(() => {
      running = undefined;
    });
    const result = await running;
    completed = true;
    return context.json({
      complete: true,
      recovery_id: result.recoveryId,
      events: result.events,
      workspaces: result.workspaces,
      leased_workspaces: result.leasedWorkspaces,
      unknown_runtimes: result.unknownRuntimes,
    });
  });
  app.all("*", () => {
    throw new ApiError("recovery.required", "This controller is in recovery. Run pocketcoder recovery complete.");
  });
  return app;
}
