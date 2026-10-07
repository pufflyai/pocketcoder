import { randomUUID } from "node:crypto";
import {
  type AgentFrame,
  HEADER_PROTOCOL,
  HEADER_RECONNECT,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  PROTOCOL_VERSION,
  type ProviderInput,
} from "@pstdio/pocketcoder-contracts";
import { AGENT_VERSION } from "../bootstrap/supervisor-constants";

export interface AgentConnectionCallbacks {
  services(): string[];
  onMessage(raw: string): void;
  onRegistrationFailure(): void;
  onDisconnect(): void | Promise<void>;
  isStopped(): boolean;
}

export class AgentConnection {
  private socket: WebSocket | null = null;
  private closed: Promise<void> = Promise.resolve();
  private connectionId = "";
  private sequence = 0;
  private reconnectCredential: string | null = null;

  constructor(
    private readonly input: ProviderInput,
    private readonly callbacks: AgentConnectionCallbacks,
  ) {}

  connect(first = true) {
    const headers: Record<string, string> = {
      [HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
      [HEADER_WORKSPACE]: this.input.workspace_id,
    };
    if (first || !this.reconnectCredential) {
      headers[HEADER_REGISTRATION] = this.input.registration_secret;
    } else {
      headers[HEADER_RECONNECT] = this.reconnectCredential;
    }
    this.connectionId = randomUUID();
    this.sequence = 0;
    const socket = new WebSocket(this.url(), { headers } as unknown as string[]);
    this.socket = socket;
    socket.onopen = () => {
      this.send("registered", {
        agent_version: AGENT_VERSION,
        template: {
          name: this.input.template_name,
          version: this.input.template_version,
          digest: this.input.template_digest,
        },
        services: this.callbacks.services(),
        pid: process.pid,
      });
    };
    socket.onmessage = (event) => this.callbacks.onMessage(String(event.data));
    socket.onerror = () => {
      // onclose owns retry behavior.
    };
    this.closed = new Promise<void>((resolve, reject) => {
      socket.onclose = () => {
        Promise.resolve()
          .then(() => this.callbacks.onDisconnect())
          .then(resolve, reject);
        this.reconnect();
      };
    });
    // Retain failure for close() without an unhandled event-callback rejection.
    void this.closed.catch(() => {});
  }

  private reconnect() {
    if (this.callbacks.isStopped()) return;
    if (!this.reconnectCredential) {
      this.callbacks.onRegistrationFailure();
      return;
    }
    setTimeout(() => {
      if (!this.callbacks.isStopped()) this.connect(false);
    }, 2000);
  }

  setReconnectCredential(value: string) {
    this.reconnectCredential = value;
  }

  send(type: AgentFrame["type"], payload: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.sequence += 1;
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        workspace_id: this.input.workspace_id,
        connection_id: this.connectionId,
        seq: this.sequence,
        sent_at: new Date().toISOString(),
        payload,
      }),
    );
    return true;
  }

  async close() {
    this.socket?.close(1000, "supervisor exiting");
    await this.closed;
  }

  private url() {
    const base = this.input.server_url.replace(/^http/, "ws").replace(/\/$/, "");
    return `${base}/v1/agent/connect`;
  }
}
