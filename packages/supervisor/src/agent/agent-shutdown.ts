import type { AgentFrame } from "@pstdio/pocketcoder-contracts";
import { SupervisorCleanup } from "../lifecycle/supervisor-cleanup";

export async function shutdownAgent(
  graceMs: number,
  callbacks: {
    closeSessions(): Promise<void>;
    syncMessages(signal: AbortSignal): Promise<void>;
    signal(signal: "SIGTERM" | "SIGKILL"): void;
    exited(): Promise<number>;
    close(): Promise<void>;
    send(type: AgentFrame["type"], payload: unknown): boolean;
    log(message: string): void;
  },
) {
  const controller = new AbortController();
  const cleanup = new SupervisorCleanup();
  // History capture shares the existing termination deadline; it cannot extend it.
  const timer = setTimeout(() => {
    controller.abort(new Error("termination deadline exceeded"));
    void cleanup.attempt(() => callbacks.send("termination_ack", { phase: "killed" }));
    void cleanup.attempt(() => callbacks.signal("SIGKILL"));
  }, graceMs);
  try {
    await cleanup.attempt(() => callbacks.closeSessions());
    try {
      await callbacks.syncMessages(controller.signal);
    } catch (error) {
      callbacks.log(
        `Final AgentAPI transcript sync failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!controller.signal.aborted) {
      await cleanup.attempt(() => callbacks.signal("SIGTERM"));
      await cleanup.attempt(() => callbacks.send("termination_ack", { phase: "term_sent" }));
    }
    await cleanup.attempt(() => callbacks.exited());
    await cleanup.attempt(() => controller.signal.throwIfAborted());
    if (!cleanup.failed) await cleanup.attempt(() => callbacks.send("termination_ack", { phase: "exited" }));
    await cleanup.attempt(() => callbacks.close());
    await cleanup.attempt(() => controller.signal.throwIfAborted());
    cleanup.assertComplete();
  } finally {
    clearTimeout(timer);
  }
}
