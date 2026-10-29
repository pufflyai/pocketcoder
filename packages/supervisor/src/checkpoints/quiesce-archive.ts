import type { AgentFrame } from "@pstdio/pocketcoder-contracts";

export async function quiesceArchive(
  operationId: string,
  deadlineMs: number,
  signal: AbortSignal,
  callbacks: {
    native: boolean;
    hasHook: boolean;
    prepareHook(): Promise<boolean>;
    closeSessions(): Promise<void>;
    setQuiescing(): void;
    runtime(): { signal(signal: "SIGTERM" | "SIGKILL"): void; close(): Promise<void> } | null;
    child(): { kill(signal: "SIGTERM" | "SIGKILL"): void; exited: Promise<number> } | null;
    drainChild(): Promise<void>;
    send(type: AgentFrame["type"], payload: unknown): boolean;
  },
) {
  callbacks.setQuiescing();
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const timer = setTimeout(() => abort.abort(new Error("Checkpoint quiescence deadline exceeded.")), deadlineMs);
  let child: ReturnType<typeof callbacks.child>;
  let runtime: ReturnType<typeof callbacks.runtime>;
  function stop() {
    child?.kill("SIGKILL");
    runtime?.signal("SIGKILL");
  }
  combined.addEventListener("abort", stop, { once: true });
  try {
    runtime = callbacks.runtime();
    if (runtime && !callbacks.hasHook)
      throw new Error("Service checkpoint capture requires its image-owned writer hook.");
    await untilAborted(callbacks.closeSessions(), combined);
    combined.throwIfAborted();
    if (callbacks.native || callbacks.hasHook) {
      if (!(await untilAborted(callbacks.prepareHook(), combined))) return false;
    } else callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiescing" });
    if (runtime) {
      await untilAborted(runtime.close(), combined);
    } else {
      child = callbacks.child();
      combined.throwIfAborted();
      if (!child) throw new Error("Checkpoint harness is missing.");
      child.kill("SIGTERM");
      const code = await untilAborted(child.exited, combined);
      await untilAborted(callbacks.drainChild(), combined);
      if (code !== 0 && code !== 143) throw new Error("Checkpoint harness shutdown failed.");
    }
    combined.throwIfAborted();
    if (!callbacks.native && !callbacks.hasHook)
      callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiesced" });
    return true;
  } catch {
    callbacks.send("checkpoint_status", { operation_id: operationId, phase: "failed" });
    return false;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", stop);
  }
}

async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}
