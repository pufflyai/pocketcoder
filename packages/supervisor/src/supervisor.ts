import { type ExecSpec, type ProviderInput, parseDurationMs, type ServerFrame } from "@pstdio/pocketcoder-contracts";
import { AgentConnection } from "./agent/agent-connection";
import { AgentHealthMonitor } from "./agent/agent-health";
import { shutdownAgent } from "./agent/agent-shutdown";
import { AttachmentManager } from "./attachments/attachments";
import { loadProviderInput } from "./bootstrap/supervisor-bootstrap";
import { EXIT_PROTOCOL_ERROR, EXIT_REGISTRATION_FAILED } from "./bootstrap/supervisor-constants";
import { startNetworkMonitor } from "./bootstrap/supervisor-setup";
import { prepareSupervisorWorkspace } from "./bootstrap/workspace-startup";
import { prepareCheckpoint } from "./checkpoints/checkpoint-coordinator";
import { startSupervisorHarness } from "./lifecycle/harness-process";
import { closeSupervisorResources } from "./lifecycle/supervisor-cleanup";
import { supervisorMessageReceiver } from "./lifecycle/supervisor-message";
import { SupervisorWork } from "./lifecycle/supervisor-work";
import { SupervisorLogs } from "./observability/supervisor-logs";
import { relayProxyRequest } from "./proxy/proxy-relay";
import { ProxyStreamCoordinator } from "./proxy/proxy-stream";
import { TerminalManager } from "./terminals/terminal-manager";

// PID 1 inside every workspace. It registers with pocketcoder-server, then
// manages setup, the harness, health, logs, relays, and shutdown.

type ChildPhase = "starting" | "setup" | "running" | "exited" | "terminating";

export async function supervise(inputPath: string): Promise<number> {
  const supervisor = new Supervisor(await loadProviderInput(inputPath));
  return await supervisor.run();
}

class Supervisor {
  private readonly work = new SupervisorWork();
  private shutdown: Promise<void> | null = null;
  private closure: Promise<void> | null = null;
  private readonly connection: AgentConnection;
  private readonly logs: SupervisorLogs;
  private readonly healthMonitor: AgentHealthMonitor;
  private readonly attachments: AttachmentManager;
  private readonly proxyStreams: ProxyStreamCoordinator;
  private readonly terminals: TerminalManager;
  private exec: ExecSpec | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private childPhase: ChildPhase = "starting";
  private childExit: number | null = null;
  private harnessCompletion: Promise<number> | null = null;
  private readonly lifetime = new AbortController();

  private get shuttingDown() {
    return this.lifetime.signal.aborted;
  }
  private quiescing = false;
  private readonly done: Promise<number>;
  private finish!: (code: number) => void;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private execReady!: () => void;
  private readonly execReadyPromise: Promise<void>;

  constructor(private readonly input: ProviderInput) {
    this.connection = new AgentConnection(input, {
      services: () => (this.exec ? Object.keys(this.exec.services) : []),
      onMessage: supervisorMessageReceiver({
        isStopped: () => this.shuttingDown,
        handle: this.handleMessage.bind(this),
        work: this.work,
        log: (message) => this.logs.log(message),
      }),
      onRegistrationFailure: () => this.exitWith(EXIT_REGISTRATION_FAILED),
      onDisconnect: () => this.work.run(() => this.proxyStreams.cancelAll()),
      isStopped: () => this.shuttingDown || this.childExit !== null,
    });
    this.logs = new SupervisorLogs(this.sendFrame.bind(this));
    this.proxyStreams = new ProxyStreamCoordinator(this.sendFrame.bind(this));
    this.terminals = new TerminalManager(() => this.exec, this.sendFrame.bind(this));
    this.attachments = new AttachmentManager(this.sendFrame.bind(this));
    this.healthMonitor = new AgentHealthMonitor(
      {
        exec: () => this.exec,
        childPhase: () => this.childPhase,
        send: this.sendFrame.bind(this),
        log: this.logs.log.bind(this.logs),
      },
      this.work,
    );
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.execReadyPromise = new Promise((resolve) => {
      this.execReady = resolve;
    });
  }

  async run(): Promise<number> {
    const shutdown = () => {
      void this.requestShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      return await this.runWorkspace();
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }

  private async runWorkspace(): Promise<number> {
    this.connection.connect();
    // Wait until the server delivered the exec spec, then run setup and
    // start the harness exactly once. Registration failure resolves
    // `done` first, so a rejected connection cannot hang the supervisor.
    const raced = await Promise.race([this.execReadyPromise.then(() => null), this.done]);
    if (raced !== null) return raced;
    const exec = this.exec;
    if (!exec) return EXIT_PROTOCOL_ERROR;
    if (this.shuttingDown) return await this.done;
    const setupCode = await this.work.run(() =>
      prepareSupervisorWorkspace(exec, {
        send: this.sendFrame.bind(this),
        log: this.logs.log.bind(this.logs),
        pump: this.logs.pump.bind(this.logs),
        addSecret: this.logs.addSecret.bind(this.logs),
        removeSecret: this.logs.removeSecret.bind(this.logs),
        signal: this.lifetime.signal,
        isStopped: () => this.shuttingDown,
        setSetupPhase: () => {
          this.childPhase = "setup";
        },
        setChild: (child) => {
          this.child = child;
        },
      }),
    );
    if (this.shuttingDown) return await this.done;
    if (setupCode !== null) {
      await this.flushAndClose();
      return setupCode;
    }
    this.startHarness(exec);
    this.timers.push(this.healthMonitor.start(exec));
    const networkMonitor = startNetworkMonitor(
      exec,
      this.sendFrame.bind(this),
      (code) => {
        this.child?.kill("SIGKILL");
        void this.flushAndClose().then(() => this.exitWith(code));
      },
      this.work,
      this.lifetime.signal,
    );
    if (networkMonitor) this.timers.push(networkMonitor);
    this.timers.push(this.healthMonitor.startHeartbeat());
    return await this.done;
  }

  private requestShutdown(): Promise<void> {
    this.shutdown ??= this.gracefulShutdown();
    return this.shutdown;
  }

  private sendFrame(type: Parameters<AgentConnection["send"]>[0], payload: unknown) {
    return this.connection.send(type, payload);
  }

  private async handleMessage(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "registered_ack": {
        if (frame.payload.reconnect_credential) {
          this.connection.setReconnectCredential(frame.payload.reconnect_credential);
        }
        if (this.healthMonitor.state !== "unknown") {
          this.sendFrame("agent_state", { state: this.healthMonitor.state });
        }
        if (!this.exec) {
          this.exec = frame.payload.exec;
          await this.attachments.cleanupStartup();
          this.execReady();
        }
        return;
      }
      case "proxy_request":
        await relayProxyRequest(frame.payload, {
          exec: () => this.exec,
          isQuiescing: () => this.quiescing,
          send: this.sendFrame.bind(this),
          onAgentTurn: () => this.healthMonitor.setAgentState("running"),
          probeAgent: (exec) => {
            void this.work.run(() => this.healthMonitor.probeService(exec, "agent", true));
          },
          relayStream: (request, service, route) => this.proxyStreams.relay(request, service, route),
        });
        return;
      case "proxy_stream_ack":
        this.proxyStreams.handleAck(frame.payload);
        return;
      case "proxy_stream_cancel":
        await this.proxyStreams.handleCancel(frame.payload);
        return;
      case "terminal_open":
        this.terminals.open(frame.payload);
        return;
      case "terminal_input":
        this.terminals.input(frame.payload);
        return;
      case "terminal_resize":
        this.terminals.resize(frame.payload);
        return;
      case "terminal_close":
        await this.terminals.close(frame.payload);
        return;
      case "signal": {
        if (frame.payload.signal === "KILL") {
          this.forwardSignal("SIGKILL");
          this.sendFrame("termination_ack", { phase: "killed" });
          await this.requestShutdown();
        } else {
          await this.requestShutdown();
        }
        return;
      }
      case "health_probe": {
        const exec = this.exec;
        if (exec) await this.healthMonitor.probeService(exec, frame.payload.service, true);
        return;
      }
      case "shutdown": {
        await this.requestShutdown();
        return;
      }
      case "attachment_start":
        await this.attachments.handleStart(frame.payload);
        return;
      case "attachment_chunk":
        await this.attachments.handleChunk(frame.payload);
        return;
      case "attachment_finish":
        await this.attachments.handleFinish(frame.payload);
        return;
      case "attachment_abort":
        await this.attachments.handleAbort(frame.payload);
        return;
      case "attachment_resolve":
        await this.attachments.handleResolve(frame.payload);
        return;
      case "prepare_checkpoint": {
        await prepareCheckpoint(frame.payload.operation_id, frame.payload.deadline_ms, {
          exec: () => this.exec,
          send: this.sendFrame.bind(this),
          pump: this.logs.pump.bind(this.logs),
          readAgentApiStatus: this.healthMonitor.readAgentApiStatus.bind(this.healthMonitor),
          syncAgentApiMessages: this.healthMonitor.syncMessages.bind(this.healthMonitor),
          child: () => this.child,
          childExited: () => this.childExit !== null,
          closeTerminals: () => this.terminals.closeAll("checkpoint"),
          setQuiescing: (value) => {
            this.quiescing = value;
          },
        });
        return;
      }
    }
  }

  private startHarness(exec: ExecSpec): void {
    this.childPhase = "running";
    this.sendFrame("process_state", { phase: "running" });
    // The caller's opaque launch input reaches the harness in memory
    // only; it is never written to the workspace filesystem by the
    // supervisor and the server erases its copy at readiness.
    const harness = startSupervisorHarness(exec, this.input, this.logs);
    this.child = harness.child;
    this.harnessCompletion = harness.completion.then((code) => {
      this.childPhase = "exited";
      this.childExit = code;
      this.sendFrame("process_state", { phase: "exited", exit_code: code });
      return code;
    });
    void this.harnessCompletion.then(async () => {
      if (this.quiescing || this.shuttingDown) return;
      await this.finishShutdown(this.flushAndClose());
    });
  }

  private forwardSignal(signal: "SIGTERM" | "SIGKILL"): void {
    this.childPhase = "terminating";
    if (this.child && this.childExit === null) {
      this.child.kill(signal);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.closeAdmission();
    this.quiescing = true;
    const exec = this.exec;
    const graceMs = exec ? parseDurationMs(exec.timeouts.terminateGrace) : 15_000;
    await this.finishShutdown(
      shutdownAgent(graceMs, {
        closeSessions: async () => {
          await this.proxyStreams.cancelAll();
          await this.terminals.closeAll("workspace_ended");
          await this.work.join();
        },
        syncMessages: async (signal) => {
          if (exec?.agentapi_native) await this.healthMonitor.syncMessages({ fresh: true, signal });
        },
        signal: this.forwardSignal.bind(this),
        exited: () => this.harnessCompletion ?? this.child?.exited ?? Promise.resolve(0),
        close: this.flushAndClose.bind(this),
        send: this.sendFrame.bind(this),
        log: this.logs.log.bind(this.logs),
      }),
    );
  }

  private flushAndClose(): Promise<void> {
    this.closure ??= closeSupervisorResources({
      closeAdmission: this.closeAdmission.bind(this),
      cancelStreams: () => this.proxyStreams.cancelAll(),
      closeTerminals: () => this.terminals.closeAll("workspace_ended"),
      joinWork: () => this.work.join(),
      joinOutput: async () => await this.harnessCompletion,
      closeConnection: () => this.connection.close(),
    });
    return this.closure;
  }

  private closeAdmission(): void {
    this.lifetime.abort(new Error("supervisor_admission_closed"));
    this.healthMonitor.stopBackground();
    for (const timer of this.timers) clearInterval(timer);
  }

  private async finishShutdown(operation: Promise<void>): Promise<void> {
    try {
      await operation;
      this.exitWith(this.childExit ?? 0);
    } catch (error) {
      this.logs.log(String(error));
      this.exitWith(this.childExit || 1);
    }
  }

  private exitWith(code: number): void {
    for (const timer of this.timers) clearInterval(timer);
    this.finish(code);
  }
}
