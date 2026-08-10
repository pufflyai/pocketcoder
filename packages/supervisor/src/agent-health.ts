import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { agentApiConversationMessages } from "./agentapi";

type AgentState = "unknown" | "stable" | "running";
type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export class AgentHealthMonitor {
  private currentState: AgentState = "unknown";
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
  ) {}

  get state() {
    return this.currentState;
  }

  setAgentState(state: "running" | "stable") {
    if (this.currentState === state) return;
    this.currentState = state;
    this.callbacks.send("agent_state", { state });
  }

  start(exec: ExecSpec) {
    const timer = setInterval(() => void this.probeAll(exec, false), 5000);
    void this.probeAll(exec, true);
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
        signal: AbortSignal.timeout(3000),
      });
      health = response.ok ? "healthy" : "unhealthy";
      if (response.ok && name === "agent") {
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        if (body?.status === "running" || body?.status === "stable") {
          this.setAgentState(body.status);
          if (body.status === "stable" && exec.agentapi_native) void this.syncMessages();
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

  syncMessages(): Promise<void> {
    if (this.transcriptSync) return this.transcriptSync;
    this.transcriptSync = this.performMessageSync().finally(() => {
      this.transcriptSync = null;
    });
    return this.transcriptSync;
  }

  private async probeAll(exec: ExecSpec, force: boolean) {
    for (const name of Object.keys(exec.services)) await this.probeService(exec, name, force);
  }

  private async performMessageSync() {
    const service = this.callbacks.exec()?.services.agent;
    if (!service || this.currentState !== "stable") return;
    try {
      const response = await fetch(new URL("/messages", service.baseUrl), {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`AgentAPI messages returned ${response.status}`);
      for (const message of agentApiConversationMessages(await response.json())) {
        const id = Number(message.message_id.slice("agentapi:".length));
        if (id <= this.lastMessageId) continue;
        if (!this.callbacks.send("conversation_message", message)) return;
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
