import type { AgentFrame, ExecSpec, ServerFrame } from "@pstdio/pocketcoder-contracts";
import { SupervisorPreviewSockets } from "./preview-sockets";
import { relayProxyRequest } from "./proxy-relay";
import { ProxyStreamCoordinator } from "./proxy-stream";

type ProxyFrame = Extract<
  ServerFrame,
  { type: "proxy_request" | "proxy_stream_ack" | "proxy_stream_cancel" | "preview_socket" }
>;

export class SupervisorProxy {
  private readonly streams: ProxyStreamCoordinator;
  private readonly sockets: SupervisorPreviewSockets;

  constructor(
    private readonly callbacks: {
      exec(): ExecSpec | null;
      isQuiescing(): boolean;
      send(type: AgentFrame["type"], payload: unknown): boolean;
      onAgentTurn(): void;
      probeAgent(exec: ExecSpec): void;
    },
  ) {
    this.streams = new ProxyStreamCoordinator(callbacks.send);
    this.sockets = new SupervisorPreviewSockets(callbacks.exec, (payload) => {
      callbacks.send("preview_socket", payload);
    });
  }

  async handle(frame: ProxyFrame) {
    switch (frame.type) {
      case "proxy_request":
        return relayProxyRequest(frame.payload, {
          ...this.callbacks,
          relayStream: (request, service, route) => this.streams.relay(request, service, route),
        });
      case "proxy_stream_ack":
        this.streams.handleAck(frame.payload);
        return;
      case "proxy_stream_cancel":
        return this.streams.handleCancel(frame.payload);
      case "preview_socket":
        if (!this.callbacks.isQuiescing() || frame.payload.op !== "open") this.sockets.receive(frame.payload);
        else this.callbacks.send("preview_socket", { op: "close", request_id: frame.payload.request_id });
    }
  }

  async closeAll() {
    this.sockets.closeAll();
    await this.streams.cancelAll();
  }
}
