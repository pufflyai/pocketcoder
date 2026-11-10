import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";

export class AgentHealthMonitor {
  private readonly serviceHealth = new Map<string, string>();
  constructor(
    private readonly callbacks: {
      exec(): ExecSpec | null;
      childPhase(): string;
      send(type: AgentFrame["type"], payload: unknown): boolean;
      log(message: string): void;
    },
  ) {}
  start(exec: ExecSpec) {
    const probe = async (force: boolean) => {
      for (const name of Object.keys(exec.services)) await this.probeService(exec, name, force);
    };
    void probe(true);
    return setInterval(() => void probe(false), 5000);
  }
  startHeartbeat() {
    return setInterval(() => this.callbacks.send("heartbeat", { child: this.callbacks.childPhase() }), 15_000);
  }
  async probeService(exec: ExecSpec, name: string, force: boolean) {
    const service = exec.services[name];
    if (!service) return;
    let health = "starting";
    try {
      const response = await fetch(new URL(service.healthPath, service.baseUrl), { signal: AbortSignal.timeout(3000) });
      health = response.ok ? "healthy" : "unhealthy";
    } catch {
      health = this.callbacks.childPhase() === "running" ? "unhealthy" : "starting";
    }
    if (force || this.serviceHealth.get(name) !== health) {
      this.serviceHealth.set(name, health);
      this.callbacks.send("service_health", { service: name, health });
    }
  }
}
