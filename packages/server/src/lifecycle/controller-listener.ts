// Owns actual admission closure and joins userspace work while retaining the coordinator lease.
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";
import type { ServerConfig } from "../config/config";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "../observability/server-timing";

export interface RunningPocketCoderServer {
  config: ServerConfig;
  url: string;
  quiesce(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

function withinSignal(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function startControllerListener(
  config: ServerConfig,
  built: BuiltServer,
  lifetime: {
    store: Store;
    timers: { stop(): Promise<void> }[];
    policyDrain?: () => Promise<void>;
    initialWork?: Promise<unknown>;
  },
): RunningPocketCoderServer {
  const listener = Bun.serve({
    hostname: config.listenHost,
    port: config.listenPort,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: built.app.fetch,
    websocket: built.websocket,
  });
  const host = config.listenHost === "0.0.0.0" || config.listenHost === "::" ? "127.0.0.1" : config.listenHost;
  let settlement: Promise<void> | null = null;
  let quiescence: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  const settle = () => {
    settlement ??= (async () => {
      const joining = built.operations.close();
      const timers = lifetime.timers.map((timer) => timer.stop());
      const settled = await Promise.allSettled([
        listener.stop(true),
        ...timers,
        joining,
        lifetime.policyDrain?.(),
        lifetime.initialWork,
      ]);
      const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, "controller_tasks_unsettled");
    })();
    return settlement;
  };
  return {
    config,
    url: `http://${host}:${listener.port}`,
    quiesce(signal) {
      // The programmatic public lifecycle caller owns control. A mutation cannot join itself.
      built.operations.assertControlCaller();
      if (quiescence) return quiescence;
      signal.throwIfAborted();
      quiescence = withinSignal(settle(), signal);
      return quiescence;
    },
    stop() {
      built.operations.assertControlCaller();
      // An aborted observer cannot release the lease: actual settlement remains mandatory.
      stopping ??= settle().then(() => lifetime.store.close());
      return stopping;
    },
  };
}
