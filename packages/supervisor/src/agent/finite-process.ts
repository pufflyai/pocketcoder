import type { FiniteProcessFact, Harness, ProcessReference } from "@pstdio/pocketcoder-contracts";
import { groupHasWriters } from "./process-group";

export class FiniteProcess {
  private fact: FiniteProcessFact | null = null;
  private groupStopped = false;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private readonly cancellations = new Map<string, string>();
  private groupStop: Promise<void> | null = null;
  private killDeadline: number | null = null;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  drained = Promise.resolve();

  constructor(
    private readonly workspaceId: string,
    private readonly incarnationId: string,
    private readonly observe: (fact: FiniteProcessFact) => void,
    private readonly pump: (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => Promise<void> = async (
      stream,
    ) => {
      for await (const _chunk of stream) {
        /* Drain without retaining workload output. */
      }
    },
    private readonly finalizationGraceMs = 15_000,
  ) {}

  lookup(execution: ProcessReference) {
    this.assertRuntime(execution);
    if (this.fact && this.fact.execution.requestId !== execution.requestId) return null;
    return this.fact;
  }

  start(
    execution: ProcessReference,
    fingerprint: string,
    command: Omit<Harness, "env"> & { env: Record<string, string | undefined> },
  ) {
    this.assertRuntime(execution);
    if (this.cancellations.has(execution.requestId) && !this.fact) return null;
    if (this.fact) {
      if (this.fact.execution.requestId !== execution.requestId) throw new Error("Finite process already claimed");
      if (this.fact.fingerprint !== fingerprint) throw new Error("Process fingerprint conflict");
      return this.fact;
    }
    // Claim before spawn. A supervisor crash ends this incarnation rather than replaying uncertain work.
    const claimed: FiniteProcessFact = {
      execution,
      fingerprint,
      phase: "claimed",
      processGroupId: null,
      claimedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
    };
    this.publish(claimed);
    try {
      const child = Bun.spawn(command.command, {
        cwd: command.cwd ?? "/",
        env: command.env,
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.child = child;
      const running = {
        ...claimed,
        phase: "running" as const,
        processGroupId: child.pid,
        startedAt: new Date().toISOString(),
      };
      this.publish(running);
      const pumps = [this.pump(child.stdout, "stdout"), this.pump(child.stderr, "stderr")];
      this.drained = child.exited.then(async (code) => {
        // Keep the exact leader receipt private until all group writers stop.
        this.fact = {
          ...running,
          phase: "exited",
          exitCode: child.signalCode ? null : code,
          signal: child.signalCode,
          endedAt: new Date().toISOString(),
        };
        await this.stopGroup("SIGTERM", this.finalizationGraceMs);
        this.replay();
        await Promise.all(pumps);
      });
    } catch {
      this.publish({ ...claimed, phase: "lost", endedAt: new Date().toISOString() });
    }
    return this.fact;
  }

  cancel(execution: ProcessReference, signal: "SIGTERM" | "SIGKILL") {
    const fact = this.lookup(execution);
    if (!fact) throw new Error("Unknown process request");
    if (fact.phase === "running") this.signalGroup(signal);
    return fact;
  }

  cancelOperation(
    execution: ProcessReference,
    cancelId: string,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
    graceMs?: number,
  ) {
    this.assertRuntime(execution);
    const previous = this.cancellations.get(execution.requestId);
    if (previous && previous !== cancelId) throw new Error("Cancel identity conflict");
    const fact = this.lookup(execution);
    if (fact?.phase === "lost" || (fact?.phase === "exited" && this.groupStopped)) return "terminal" as const;
    this.cancellations.set(execution.requestId, cancelId);
    if (!fact) return "canceled" as const;
    this.stopGroup(signal, graceMs ?? this.finalizationGraceMs);
    return "requested" as const;
  }

  exited() {
    return this.child?.exited ?? Promise.resolve(0);
  }

  async stopWriters(signal: "SIGTERM" | "SIGKILL") {
    this.signalGroup(signal);
    await this.child?.exited;
    await this.waitForGroupStop();
  }

  replay() {
    if (this.fact && !(this.fact.phase === "exited" && !this.groupStopped)) this.observe(this.fact);
  }

  private assertRuntime(execution: ProcessReference) {
    if (
      execution.workspaceId !== this.workspaceId ||
      execution.incarnationId !== this.incarnationId ||
      execution.owner !== "process"
    )
      throw new Error("Process reference belongs to a different runtime");
  }

  private signalGroup(signal: "SIGTERM" | "SIGKILL") {
    if (this.groupStopped || !this.fact?.processGroupId) return;
    try {
      process.kill(-this.fact.processGroupId, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // macOS can deny a group signal while its final members are exiting.
      if (code === "EPERM") return;
      if (code !== "ESRCH") throw error;
      this.groupStopped = true;
    }
  }

  private publish(fact: FiniteProcessFact) {
    this.fact = fact;
    this.replay();
  }

  private stopGroup(signal: "SIGTERM" | "SIGKILL", graceMs: number) {
    this.signalGroup(signal);
    const deadline = performance.now() + graceMs;
    // A delayed cancel can shorten ordinary cleanup, but retries cannot extend it.
    if (!this.groupStopped && (this.killDeadline === null || deadline < this.killDeadline)) {
      clearTimeout(this.killTimer);
      this.killDeadline = deadline;
      this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    }
    this.groupStop ??= this.waitForGroupStop().finally(() => clearTimeout(this.killTimer));
    return this.groupStop;
  }

  private async waitForGroupStop() {
    while (!this.groupStopped && this.fact?.processGroupId) {
      if (this.killDeadline !== null && performance.now() >= this.killDeadline) this.signalGroup("SIGKILL");
      this.groupStopped = !groupHasWriters(this.fact.processGroupId);
      if (!this.groupStopped) await Bun.sleep(10);
    }
  }
}
