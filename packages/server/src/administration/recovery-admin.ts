import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { RecoveryState } from "@pstdio/pocketcoder-db";
import { type JournalSnapshot, RuntimeTerminationSchema } from "@pstdio/pocketcoder-db/off-node";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { completeRecovery } from "../recovery/complete-recovery";
import type { OffNodeRecovery } from "../recovery/off-node-recovery";

type Completion = Awaited<ReturnType<typeof completeRecovery>>;

// The only routes a controller in recovery serves, on its private admin socket.
export function recoveryAdmin(
  recovery: RecoveryState,
  complete: () => Promise<Completion>,
  journalSnapshot?: () => JournalSnapshot,
  offNode?: OffNodeRecovery,
) {
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
      ...(journalSnapshot ? { writer: journalSnapshot().writer, current_journal: journalSnapshot().head } : {}),
    }),
  );
  if (offNode) {
    app.get("/v1/backup/restoration", async (context) => context.json(await offNode.status()));
    app.post("/v1/recovery/claim", async (context) => {
      const input = z.strictObject({ operation_id: z.uuid() }).parse(await context.req.json());
      return context.json(await offNode.claim(input.operation_id));
    });
    app.post("/v1/recovery/runtime", async (context) => {
      const input = RuntimeTerminationSchema.extend({ operation_id: z.uuid(), snapshot_id: z.uuid() }).parse(
        await context.req.json(),
      );
      return context.json(
        await offNode.handoff(input.operation_id, input.snapshot_id, input.identity, input.termination),
      );
    });
  }
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
