import { type ExecSpec, type ProviderInput, parseDurationMs, ServerFrameSchema } from "@pstdio/pocketcoder-contracts";
import { AgentConnection } from "./agent/agent-connection";
import { AgentHealthMonitor } from "./agent/agent-health";
import { shutdownAgent } from "./agent/agent-shutdown";
import { createSupervisorHarness } from "./agent/supervisor-harness";
import { SupervisorTransfers } from "./agent/supervisor-transfers";
import { AttachmentManager } from "./attachments/attachments";
import { prepareWorkspace } from "./bootstrap/prepare-workspace";
import { SetupCompletion } from "./bootstrap/setup-completion";
import { loadProviderInput } from "./bootstrap/supervisor-bootstrap";
import {
  EXIT_NETWORK_POLICY_FAILED,
  EXIT_PROTOCOL_ERROR,
  EXIT_REGISTRATION_FAILED,
  EXIT_SETUP_FAILED,
} from "./bootstrap/supervisor-constants";
import { clearSourceCredential, preflightNetwork, startNetworkMonitor } from "./bootstrap/supervisor-setup";
import { prepareCheckpoint } from "./checkpoints/checkpoint-coordinator";
import { quiesceArchive } from "./checkpoints/quiesce-archive";
import { WorkspaceCredentials } from "./credentials/workspace-credentials";
import { SupervisorLogs } from "./observability/supervisor-logs";
import { SupervisorProxy } from "./proxy/supervisor-proxy";
import { TerminalManager } from "./terminals/terminal-manager";

export async function supervise(inputPath: string): Promise<number> {
  const supervisor = new Supervisor(await loadProviderInput(inputPath));
  return await supervisor.run();
}

class Supervisor {
  private readonly connection: AgentConnection;
  private readonly logs: SupervisorLogs;
  private readonly healthMonitor: AgentHealthMonitor;
  private readonly attachments: AttachmentManager;
  private readonly proxy: SupervisorProxy;
  private readonly terminals: TerminalManager;
  private readonly transfers: SupervisorTransfers;
  private readonly harness: ReturnType<typeof createSupervisorHarness>;
  private readonly credentials: WorkspaceCredentials;
  private exec: ExecSpec | null = null;
  private readonly setupAbort = new AbortController();
  private readonly setupCompletion = new SetupCompletion((requestId) =>
    this.sendFrame("setup_complete", { request_id: requestId }),
  );
  private shuttingDown = false;
  private quiescing = false;
  private readonly done: Promise<number>;
  private finish!: (code: number) => void;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private execReady!: () => void;
  private readonly execReadyPromise: Promise<void>;

  constructor(input: ProviderInput) {
    this.connection = new AgentConnection(input, {
      services: () => (this.exec ? Object.keys(this.exec.services) : []),
      onMessage: (raw) => void this.handleMessage(raw),
      onRegistrationFailure: () => this.exitWith(EXIT_REGISTRATION_FAILED),
      onDisconnect: () => {
        void this.proxy.closeAll();
        void this.transfers.cancel().catch((error) => this.logs.log(String(error)));
      },
      isStopped: () => this.shuttingDown || (this.harness.exitCode !== null && !this.quiescing),
    });
    this.transfers = new SupervisorTransfers(input.server_url, input.template_digest, {
      connection: () => this.connection.transferConnection(),
      send: this.sendFrame.bind(this),
      quiesce: (operationId, deadlineMs, signal) =>
        quiesceArchive(operationId, deadlineMs, signal, {
          native: this.exec?.agentapi_native === true,
          hasHook: !!this.exec?.checkpoint_hook,
          prepareHook: () => this.quiesce(operationId, deadlineMs),
          closeSessions: async () => {
            await this.terminals.closeAll("checkpoint");
            await this.proxy.closeAll();
          },
          setQuiescing: () => {
            this.quiescing = true;
            this.credentials.setQuiescing(true);
          },
          child: () => this.harness.child,
          drainChild: () => this.harness.drained,
          send: this.sendFrame.bind(this),
        }),
    });
    this.logs = new SupervisorLogs(this.sendFrame.bind(this));
    this.credentials = new WorkspaceCredentials({
      send: (message) => this.sendFrame(message.type, message.payload),
      addSecret: this.logs.addSecret.bind(this.logs),
      expired: () => {
        void this.gracefulShutdown();
      },
    });
    this.harness = createSupervisorHarness(input, {
      send: this.sendFrame.bind(this),
      logs: this.logs,
      close: this.flushAndClose.bind(this),
      isQuiesced: () => this.quiescing && !this.shuttingDown,
      exit: this.exitWith.bind(this),
    });
    this.proxy = new SupervisorProxy({
      exec: () => this.exec,
      isQuiescing: () => this.quiescing,
      send: this.sendFrame.bind(this),
      onAgentTurn: () => this.healthMonitor.setAgentState("running"),
      probeAgent: (exec) => void this.healthMonitor.probeService(exec, "agent", true),
    });
    this.terminals = new TerminalManager(() => this.exec, this.sendFrame.bind(this));
    this.attachments = new AttachmentManager(this.sendFrame.bind(this));
    this.healthMonitor = new AgentHealthMonitor({
      exec: () => this.exec,
      childPhase: () => this.harness.phase,
      send: this.sendFrame.bind(this),
      log: this.logs.log.bind(this.logs),
    });
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.execReadyPromise = new Promise((resolve) => {
      this.execReady = resolve;
    });
  }

  async run(): Promise<number> {
    const shutdown = () => {
      void this.gracefulShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      return await this.runWorkspace();
    } finally {
      await this.credentials.stop();
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }

  private async runWorkspace(): Promise<number> {
    this.connection.connect();
    // Setup waits for registration; a failed registration must still finish the supervisor.
    const raced = await Promise.race([this.execReadyPromise.then(() => null), this.done]);
    if (raced !== null) return raced;
    const exec = this.exec;
    if (!exec) return EXIT_PROTOCOL_ERROR;
    if (!(await preflightNetwork(exec, this.sendFrame.bind(this), this.flushAndClose.bind(this)))) {
      clearSourceCredential(exec);
      return EXIT_NETWORK_POLICY_FAILED;
    }

    this.timers.push(this.healthMonitor.startHeartbeat());
    const failed = await prepareWorkspace(exec, this.transfers, this.setupCompletion, {
      send: this.sendFrame.bind(this),
      close: this.flushAndClose.bind(this),
      logs: this.logs,
      abort: this.setupAbort,
      setSetupPhase: () => {
        this.harness.phase = "setup";
      },
    });
    if (failed !== null) return failed;
    if (!(await this.harness.start(exec))) return EXIT_SETUP_FAILED;
    this.timers.push(this.healthMonitor.start(exec));
    const networkMonitor = startNetworkMonitor(exec, this.sendFrame.bind(this), (code) => {
      this.harness.child?.kill("SIGKILL");
      this.exitWith(code);
    });
    if (networkMonitor) this.timers.push(networkMonitor);
    return await this.done;
  }

  private sendFrame(type: Parameters<AgentConnection["send"]>[0], payload: unknown) {
    return this.connection.send(type, payload);
  }

  private async handleMessage(raw: string): Promise<void> {
    const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "credential_renewed":
        await this.credentials.renewed(frame.payload);
        return;
      case "credential_installed_ack":
        this.credentials.confirmed(frame.payload);
        return;
      case "setup_complete_ack":
        this.setupCompletion.acknowledge(frame.payload.request_id);
        return;
      case "registered_ack": {
        this.connection.setEpoch(frame.payload.epoch);
        try {
          await this.credentials.install(frame.payload.credentials);
        } catch {
          await this.gracefulShutdown();
          return;
        }
        if (frame.payload.reconnect_credential) {
          this.connection.setReconnectCredential(frame.payload.reconnect_credential);
        }
        if (this.healthMonitor.state !== "unknown") {
          this.sendFrame("agent_state", { state: this.healthMonitor.state });
        }
        if (!this.exec) {
          this.exec = frame.payload.exec;
          this.execReady();
          void this.attachments.cleanupStartup().catch(() => {});
        }
        return;
      }
      case "preview_socket":
      case "proxy_request":
      case "proxy_stream_ack":
      case "proxy_stream_cancel":
        await this.proxy.handle(frame);
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
        } else {
          await this.gracefulShutdown();
        }
        return;
      }
      case "health_probe": {
        const exec = this.exec;
        if (exec) await this.healthMonitor.probeService(exec, frame.payload.service, true);
        return;
      }
      case "shutdown": {
        await this.gracefulShutdown();
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
      case "prepare_checkpoint_archive":
        if (this.exec)
          await this.transfers.prepare(frame.payload, this.exec).catch((error) => this.logs.log(String(error)));
        return;
      case "checkpoint_upload":
        await this.transfers.upload(frame.payload).catch((error) => this.logs.log(String(error)));
        return;
      case "prepare_checkpoint": {
        await this.quiesce(frame.payload.operation_id, frame.payload.deadline_ms);
        return;
      }
    }
  }

  private quiesce(operationId: string, deadlineMs: number) {
    return prepareCheckpoint(operationId, deadlineMs, {
      exec: () => this.exec,
      send: this.sendFrame.bind(this),
      pump: this.logs.pump.bind(this.logs),
      readAgentApiStatus: this.healthMonitor.readAgentApiStatus.bind(this.healthMonitor),
      syncAgentApiMessages: this.healthMonitor.syncMessages.bind(this.healthMonitor),
      child: () => this.harness.child,
      childExited: () => this.harness.exitCode !== null,
      closeTerminals: () => this.terminals.closeAll("checkpoint"),
      setQuiescing: (value) => {
        this.quiescing = value;
        this.credentials.setQuiescing(value);
      },
    });
  }

  private forwardSignal(signal: "SIGTERM" | "SIGKILL"): void {
    this.setupAbort.abort();
    this.setupCompletion.cancel();
    this.harness.phase = "terminating";
    if (this.harness.child && this.harness.exitCode === null) {
      this.harness.child.kill(signal);
    } else if (this.harness.exitCode !== null) {
      this.exitWith(this.harness.exitCode);
    } else {
      this.exitWith(0);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.quiescing = true;
    this.credentials.setQuiescing(true);
    this.setupAbort.abort();
    this.setupCompletion.cancel();
    await this.transfers.cancel();
    const exec = this.exec;
    const graceMs = exec ? parseDurationMs(exec.timeouts.terminateGrace) : 15_000;
    await shutdownAgent(graceMs, {
      closeSessions: async () => {
        await this.proxy.closeAll();
        await this.terminals.closeAll("workspace_ended");
      },
      syncMessages: async (signal) => {
        if (exec?.agentapi_native) await this.healthMonitor.syncMessages({ fresh: true, signal });
      },
      signal: this.forwardSignal.bind(this),
      exited: () => this.harness.child?.exited ?? Promise.resolve(0),
      send: this.sendFrame.bind(this),
      log: this.logs.log.bind(this.logs),
    });
  }

  private async flushAndClose(): Promise<void> {
    await this.credentials.stop();
    await this.transfers.cancel();
    await this.proxy.closeAll();
    await this.terminals.closeAll("workspace_ended");
    // Give queued frames a moment to flush before closing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.shuttingDown = true;
    for (const timer of this.timers) clearInterval(timer);
    try {
      this.connection.close();
    } catch {
      // Already closed.
    }
  }

  private exitWith(code: number): void {
    for (const timer of this.timers) clearInterval(timer);
    this.finish(code);
  }
}
