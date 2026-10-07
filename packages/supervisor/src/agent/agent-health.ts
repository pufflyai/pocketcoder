import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { SupervisorWork } from "../lifecycle/supervisor-work";
import { agentApiConversationMessages } from "./agentapi";

type AgentState = "unknown" | "stable" | "running";
type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

async function waitForSync(pending: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return await pending;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class AgentHealthMonitor {
  private readonly background = new AbortController();
  private currentState: AgentState = "unknown";
  private stateRevision = 0;
  private lastMessageId = -1;
  private transcriptSync: Promise<void> | null = null;
  private readonly serviceHealth = new Map<string, string>();

  constructor(
    private readonly callbacks: {
      exec(): ExecSpec | null;
      childPhase(): string;
      send: SendFrame;
      log(message: string): void;
    },
    private readonly work = new SupervisorWork(),
  ) {}

  get state() {
    return this.currentState;
  }

  setAgentState(state: "running" | "stable") {
    if (this.currentState === state) return;
    this.currentState = state;
    this.stateRevision += 1;
    this.callbacks.send("agent_state", { state });
  }

  stopBackground(): void {
    this.background.abort(new Error("supervisor_health_admission_closed"));
  }

  start(exec: ExecSpec) {
    const probe = (force: boolean) => {
      void this.work.run(() => this.probeAll(exec, force)).catch((error) => this.callbacks.log(String(error)));
    };
    const timer = setInterval(() => probe(false), 5000);
    probe(true);
    return timer;
  }

  startHeartbeat() {
    return setInterval(() => {
      this.callbacks.send("heartbeat", {
        child: this.callbacks.childPhase(),
        agentapi_state: this.currentState,
      });
    }, 15_000);
  }

  async probeService(exec: ExecSpec, name: string, force: boolean) {
    const service = exec.services[name];
    if (!service) return;
    let health: "healthy" | "unhealthy" | "starting" = "starting";
    try {
      const response = await fetch(new URL(service.healthPath, service.baseUrl), {
        signal: AbortSignal.any([this.background.signal, AbortSignal.timeout(3000)]),
      });
      health = response.ok ? "healthy" : "unhealthy";
      if (response.ok && name === "agent") {
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        if (body?.status === "running" || body?.status === "stable") {
          this.setAgentState(body.status);
          if (exec.agentapi_native) {
            // A closed read failure remains logged. Joining it must not invent a successful transcript.
            void this.work.run(async () => {
              await this.syncMessages({ signal: this.background.signal }).catch(() => {});
            });
          }
        }
      }
    } catch {
      health = this.callbacks.childPhase() === "running" ? "unhealthy" : "starting";
    }
    if (force || this.serviceHealth.get(name) !== health) {
      this.serviceHealth.set(name, health);
      this.callbacks.send("service_health", { service: name, health });
    }
  }

  async readAgentApiStatus(timeoutMs: number): Promise<"running" | "stable" | null> {
    const service = this.callbacks.exec()?.services.agent;
    if (!service || timeoutMs <= 0) return null;
    try {
      const response = await fetch(new URL(service.healthPath, service.baseUrl), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { status?: unknown };
      if (body.status !== "running" && body.status !== "stable") return null;
      this.setAgentState(body.status);
      return body.status;
    } catch {
      return null;
    }
  }

  syncMessages(options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (options.fresh) return this.syncFreshMessages(options.signal);
    if (this.transcriptSync) return this.transcriptSync;
    this.transcriptSync = this.performMessageSync(options.signal).finally(() => {
      this.transcriptSync = null;
    });
    return this.transcriptSync;
  }

  private async syncFreshMessages(signal?: AbortSignal) {
    // A read that started before Stop can miss the last accepted prompt.
    while (this.transcriptSync)
      await waitForSync(
        this.transcriptSync.catch(() => {}),
        signal,
      );
    signal?.throwIfAborted();
    await this.syncMessages({ signal });
  }

  private async probeAll(exec: ExecSpec, force: boolean) {
    for (const name of Object.keys(exec.services)) await this.probeService(exec, name, force);
  }

  private async performMessageSync(signal?: AbortSignal) {
    const service = this.callbacks.exec()?.services.agent;
    if (!service) return;
    const wasStable = this.currentState === "stable";
    const revision = this.stateRevision;
    try {
      const response = await fetch(new URL("/messages", service.baseUrl), {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`AgentAPI messages returned ${response.status}`);
      const messages = agentApiConversationMessages(await response.json());
      const completeTail = wasStable && this.currentState === "stable" && revision === this.stateRevision;
      for (const [index, message] of messages.entries()) {
        // AgentAPI mutates its last assistant message until the turn settles.
        if (index === messages.length - 1 && message.role === "assistant" && !completeTail) break;
        const id = Number(message.message_id.slice("agentapi:".length));
        if (id <= this.lastMessageId) continue;
        if (!this.callbacks.send("conversation_message", message)) throw new Error("workspace connection closed");
        this.lastMessageId = id;
      }
    } catch (error) {
      this.callbacks.log(
        `AgentAPI transcript sync failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      throw error;
    }
  }
}
