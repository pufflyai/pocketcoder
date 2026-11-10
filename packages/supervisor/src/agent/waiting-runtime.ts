import { join } from "node:path";
import {
  type AgentFrame,
  type ExecSpec,
  type ProcessReference,
  type ProviderInput,
  parseDurationMs,
  type ServerFrame,
} from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "../bootstrap/supervisor-utils";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import { FiniteProcess } from "./finite-process";
import { WorkspaceServices } from "./workspace-services";

export class WaitingRuntime {
  readonly process: FiniteProcess;
  private readonly services: WorkspaceServices;
  private serviceSocket?: string;
  private readonly spec: NonNullable<ExecSpec["workload"]>;
  private pending: ProcessReference | null = null;
  private readonly resend: ReturnType<typeof setInterval>;

  constructor(
    input: ProviderInput,
    private readonly exec: ExecSpec,
    private readonly send: (type: AgentFrame["type"], payload: unknown) => boolean,
    logs: Pick<SupervisorLogs, "pump" | "log">,
  ) {
    const spec = exec.workload;
    if (!spec || exec.harness) throw new Error("Waiting runtimes cannot start an automatic harness");
    this.spec = spec;
    this.services = new WorkspaceServices(
      spec.infrastructure,
      (env) => ({
        ...enforcedEnvironment(exec, env),
        ...(input.launch_input ? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(input.launch_input) } : {}),
        ...(this.serviceSocket ? { POCKETCODER_SERVICES_SOCKET: this.serviceSocket } : {}),
      }),
      logs,
      { workspaceId: input.workspace_id, incarnationId: spec.incarnationId },
      spec.serviceHealth,
    );
    this.process = new FiniteProcess(
      input.workspace_id,
      spec.incarnationId,
      (fact) => {
        if (fact.phase === "exited" || fact.phase === "lost") this.pending = fact.execution;
        send("finite_process", fact);
      },
      logs.pump.bind(logs),
      parseDurationMs(exec.timeouts.terminateGrace),
    );
    this.resend = setInterval(() => {
      if (this.pending) this.process.replay();
    }, 1000);
  }

  async startInfrastructure(socket?: string) {
    this.serviceSocket = socket;
    if (socket) this.services.listen(socket);
    for (const name of Object.keys(this.spec.infrastructure)) {
      if (!this.spec.manualServices?.includes(name)) await this.services.start(name);
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
          env: {
            ...enforcedEnvironment(this.exec, command.env),
            POCKETCODER_OPERATION_INPUT: JSON.stringify(frame.payload.input),
            ...(this.serviceSocket ? { POCKETCODER_SERVICES_SOCKET: this.serviceSocket } : {}),
            ...(frame.payload.inputDirectory ? { POCKETCODER_INPUT_DIRECTORY: frame.payload.inputDirectory } : {}),
          },
        });
        if (previous) this.process.replay();
        return true;
      }
      case "process_lookup":
        if (this.process.lookup(frame.payload.execution)) this.process.replay();
        else this.send("process_absent", frame.payload);
        return true;
      case "process_cancel": {
        const graceMs = Math.max(
          0,
          Math.min(
            parseDurationMs(this.exec.timeouts.terminateGrace),
            Date.parse(frame.payload.deadlineAt) - Date.now(),
          ),
        );
        this.send("process_cancel_result", {
          execution: frame.payload.execution,
          cancelId: frame.payload.cancelId,
          status: this.process.cancelOperation(
            frame.payload.execution,
            frame.payload.cancelId,
            graceMs === 0 ? "SIGKILL" : frame.payload.signal,
            graceMs,
          ),
        });
        this.process.replay();
        return true;
      }
      case "process_ack":
        if (this.pending && this.process.lookup(frame.payload.execution)) this.pending = null;
        return true;
      default:
        return false;
    }
  }

  signal(signal: "SIGTERM" | "SIGKILL") {
    void this.process.stopWriters(signal);
    this.services.signal(signal);
  }

  async close() {
    clearInterval(this.resend);
    this.signal("SIGKILL");
    await Promise.all([this.process.stopWriters("SIGKILL"), this.process.drained, this.services.close()]);
  }
}

export async function startWaitingRuntime(
  input: ProviderInput,
  exec: ExecSpec,
  send: (type: AgentFrame["type"], payload: unknown) => boolean,
  logs: Pick<SupervisorLogs, "pump" | "log">,
) {
  const socketDirectory = exec.security.writable_memory_paths[0];
  if (!socketDirectory) throw new Error("Waiting runtime requires writable service storage");
  const waiting = new WaitingRuntime(input, exec, send, logs);
  try {
    await waiting.startInfrastructure(join(socketDirectory, "services.sock"));
    return waiting;
  } catch (error) {
    await waiting.close();
    throw error;
  }
}
