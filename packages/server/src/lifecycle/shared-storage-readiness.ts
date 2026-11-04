import type { Readiness } from "../observability/health";

// Launches need shared storage, so lasting unavailability fails readiness. A shorter outage (a storage server
// restart, a network blip) only records its cause.
export const SHARED_STORAGE_FAILURE_GRACE_MS = 60_000;

export function sharedStorageReadiness(check: () => Promise<void>, readiness: Readiness, now = () => new Date()) {
  let failingSince: number | undefined;
  let status: "pending" | "ok" | "failed" = "pending";
  readiness.set("shared-storage", status);
  return async () => {
    try {
      await check();
      failingSince = undefined;
      status = "ok";
      readiness.set("shared-storage", status);
    } catch (error) {
      failingSince ??= now().getTime();
      if (now().getTime() - failingSince >= SHARED_STORAGE_FAILURE_GRACE_MS) status = "failed";
      readiness.set("shared-storage", status, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
