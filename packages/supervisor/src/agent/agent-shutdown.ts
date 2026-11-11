import type { AgentFrame } from "@pstdio/pocketcoder-contracts";

export async function shutdownAgent(
  graceMs: number,
  callbacks: {
    closeSessions(): Promise<void>;
    signal(signal: "SIGTERM" | "SIGKILL"): void;
    exited(): Promise<number>;
    send(type: AgentFrame["type"], payload: unknown): boolean;
    log(message: string): void;
  },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("termination deadline exceeded"));
    callbacks.send("termination_ack", { phase: "killed" });
    callbacks.signal("SIGKILL");
  }, graceMs);
  try {
    await callbacks.closeSessions();
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
