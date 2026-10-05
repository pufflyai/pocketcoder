import type { AgentFrame } from "@pstdio/pocketcoder-contracts";

export async function shutdownAgent(
  graceMs: number,
  callbacks: {
    closeSessions(): Promise<void>;
    syncMessages(signal: AbortSignal): Promise<void>;
    signal(signal: "SIGTERM" | "SIGKILL"): void;
    exited(): Promise<number>;
    send(type: AgentFrame["type"], payload: unknown): boolean;
    log(message: string): void;
  },
) {
  const controller = new AbortController();
  // History capture shares the existing termination deadline; it cannot extend it.
  const timer = setTimeout(() => {
    controller.abort(new Error("termination deadline exceeded"));
    callbacks.send("termination_ack", { phase: "killed" });
    callbacks.signal("SIGKILL");
  }, graceMs);
  try {
    await callbacks.closeSessions();
    try {
      await callbacks.syncMessages(controller.signal);
    } catch (error) {
      callbacks.log(
        `Final AgentAPI transcript sync failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!controller.signal.aborted) {
      callbacks.signal("SIGTERM");
      callbacks.send("termination_ack", { phase: "term_sent" });
    }
    await callbacks.exited();
    callbacks.send("termination_ack", { phase: "exited" });
  } finally {
    clearTimeout(timer);
  }
}
