import type { AgentFrame, ExecSpec, ProcessReference, ProviderInput, ServerFrame } from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "../bootstrap/supervisor-utils";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import { FiniteProcess } from "./finite-process";

export class WaitingRuntime {
  readonly process: FiniteProcess;
  private readonly services: ReturnType<typeof Bun.spawn>[] = [];
  private readonly spec: NonNullable<ExecSpec["workload"]>;
  private pending: ProcessReference | null = null;
  private readonly resend: ReturnType<typeof setInterval>;

  constructor(
    input: ProviderInput,
    private readonly exec: ExecSpec,
    private readonly send: (type: AgentFrame["type"], payload: unknown) => boolean,
    private readonly logs: Pick<SupervisorLogs, "pump" | "log">,
  ) {
    const spec = exec.workload;
    if (!spec || exec.harness) throw new Error("Waiting runtimes cannot start an automatic harness");
    this.spec = spec;
    this.process = new FiniteProcess(
      input.workspace_id,
      spec.incarnationId,
      (fact) => {
        if (fact.phase === "exited" || fact.phase === "lost") this.pending = fact.execution;
        send("finite_process", fact);
      },
      logs.pump.bind(logs),
    );
    this.resend = setInterval(() => {
      if (this.pending) this.process.replay();
    }, 1000);
  }

  startInfrastructure() {
    for (const command of Object.values(this.spec.infrastructure)) {
      const child = Bun.spawn(command.command, {
        cwd: command.cwd ?? "/",
        env: enforcedEnvironment(this.exec, command.env),
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.services.push(child);
      void this.logs.pump(child.stdout, "stdout");
      void this.logs.pump(child.stderr, "stderr");
    }
    this.reconnect();
  }

  reconnect() {
    this.send("runtime_ready", { incarnationId: this.spec.incarnationId });
    this.process.replay();
  }

  handle(frame: ServerFrame, canStart: boolean) {
    switch (frame.type) {
      case "process_start": {
        if (!canStart) throw new Error("Runtime is stopping");
        const command = Object.hasOwn(this.spec.operations, frame.payload.operation)
          ? this.spec.operations[frame.payload.operation]
          : undefined;
        if (!command || this.spec.profile !== "finite-process") throw new Error("Unsupported finite operation");
        const previous = this.process.lookup(frame.payload.execution);
        this.process.start(frame.payload.execution, frame.payload.fingerprint, {
          ...command,
          env: enforcedEnvironment(this.exec, command.env),
        });
        if (previous) this.process.replay();
        return true;
      }
      case "process_lookup":
        if (this.process.lookup(frame.payload.execution)) this.process.replay();
        return true;
      case "process_cancel":
        this.process.cancel(frame.payload.execution, frame.payload.signal);
        this.process.replay();
        return true;
      case "process_ack":
        if (this.pending && this.process.lookup(frame.payload.execution)) this.pending = null;
        return true;
      default:
        return false;
    }
  }

  signal(signal: "SIGTERM" | "SIGKILL") {
    void this.process.stopWriters(signal);
    for (const child of this.services) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  async close() {
    clearInterval(this.resend);
    this.signal("SIGKILL");
    await Promise.all([this.process.drained, ...this.services.map((child) => child.exited)]);
  }
}
