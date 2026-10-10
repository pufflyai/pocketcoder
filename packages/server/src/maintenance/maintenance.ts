import { ApiError, errorEnvelope } from "@pstdio/pocketcoder-contracts";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/middleware";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuse(): never {
  throw new ApiError("maintenance.active", "The controller is taking a backup. Retry shortly.");
}

// A maintenance window stops new mutations, waits for admitted ones to settle and then
// runs one exclusive step. Reads, heartbeats and other control-channel traffic continue.
export function createMaintenance() {
  let active = false;
  const admitted = new Set<Promise<unknown>>();
  const settlers: (() => Promise<unknown>)[] = [];

  // Stops when the window gives up, so a timed-out backup leaves no loop behind.
  async function settle(deadline: AbortSignal) {
    do {
      while (admitted.size && !deadline.aborted) await Promise.allSettled([...admitted]);
      for (const settler of settlers) if (!deadline.aborted) await settler();
    } while (admitted.size && !deadline.aborted);
  }

  async function admit<T>(work: () => Promise<T>) {
    if (active) refuse();
    const task = work();
    admitted.add(task);
    const remove = () => admitted.delete(task);
    task.then(remove, remove);
    return await task;
  }

  return {
    get active() {
      return active;
    },
    admit,
    // Background work that owns its own scheduling, such as persistence tasks.
    settleWith(settler: () => Promise<unknown>) {
      settlers.push(settler);
    },
    // Timer ticks skip a window instead of failing; the next tick catches up.
    pausable(work: () => Promise<void>) {
      return async () => {
        if (!active) await admit(work);
      };
    },
    // The deadline covers settling and the exclusive step. Writes resume on every exit.
    async run<T>(timeoutMs: number, signal: AbortSignal, step: (check: () => void) => Promise<T>) {
      if (active) refuse();
      active = true;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const check = () => {
        signal.throwIfAborted();
        if (deadline.aborted)
          throw new ApiError("maintenance.timeout", `Writes did not settle within ${timeoutMs} ms. Retry the backup.`);
      };
      const expired = new Promise<never>((_, reject) => {
        const stop = () => {
          try {
            check();
          } catch (error) {
            reject(error);
          }
        };
        if (deadline.aborted) stop();
        deadline.addEventListener("abort", stop, { once: true });
      });
      expired.catch(() => {});
      try {
        // Admitted work keeps running after a timeout; only this window gives up.
        await Promise.race([settle(deadline), expired]);
        check();
        return await step(check);
      } finally {
        active = false;
      }
    },
  };
}
export type Maintenance = ReturnType<typeof createMaintenance>;

export function maintenanceGate(maintenance: Maintenance): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (READ_METHODS.has(c.req.method)) return next();
    if (maintenance.active) {
      const error = new ApiError("maintenance.active", "The controller is taking a backup. Retry shortly.");
      return c.json(errorEnvelope(error.code, error.message, c.get("requestId")), 503, { "retry-after": "1" });
    }
    await maintenance.admit(next);
  };
}
