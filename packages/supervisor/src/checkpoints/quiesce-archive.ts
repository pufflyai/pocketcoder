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
  function stop() {
    child?.kill("SIGKILL");
  }
  combined.addEventListener("abort", stop, { once: true });
  try {
    await callbacks.closeSessions();
    combined.throwIfAborted();
    if (callbacks.native || callbacks.hasHook) {
      if (!(await callbacks.prepareHook())) return false;
    } else callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiescing" });
    child = callbacks.child();
    combined.throwIfAborted();
    if (!child) throw new Error("Checkpoint harness is missing.");
    child.kill("SIGTERM");
    const code = await child.exited;
    await callbacks.drainChild();
    combined.throwIfAborted();
    if (code !== 0 && code !== 143) throw new Error("Checkpoint harness shutdown failed.");
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
