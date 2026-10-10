import { PreviewQueueBudget, PreviewSocketFlow, type PreviewSocketMessage } from "@pstdio/pocketcoder-contracts";
import type { WSContext } from "hono/ws";
import type { LiveConnection } from "../control-channel/hub-connection";

interface Channel {
  connection: LiveConnection;
  flow?: PreviewSocketFlow;
  pending?: PreviewSocketMessage;
  ready: (protocol: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PreviewSocketBridge {
  private readonly channels = new Map<string, Channel>();
  private readonly budget = new PreviewQueueBudget();

  constructor(private readonly send: (connection: LiveConnection, message: PreviewSocketMessage) => void) {}

  async prepare(connection: LiveConnection, message: Extract<PreviewSocketMessage, { op: "open" }>) {
    const protocol = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.close(message.request_id), 10_000);
      this.channels.set(message.request_id, { connection, ready: resolve, reject, timer });
      this.send(connection, message);
    });
    return { id: message.request_id, protocol };
  }

  attach(id: string, ws: WSContext, onClose: () => void) {
    const channel = this.channels.get(id);
    if (!channel) {
      ws.close();
      onClose();
      return;
    }
    clearTimeout(channel.timer);
    const flow = new PreviewSocketFlow(
      id,
      {
        send: (data) => ws.send(typeof data === "string" ? data : new Uint8Array(data)),
        close: () => ws.close(),
        bufferedAmount: () => (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0,
      },
      (message) => this.send(channel.connection, message),
      this.budget,
      () => {
        this.channels.delete(id);
        onClose();
      },
    );
    channel.flow = flow;
    if (channel.pending) flow.receive(channel.pending);
    channel.pending = undefined;
  }

  output(id: string, raw: string | Uint8Array) {
    this.channels.get(id)?.flow?.output(raw);
  }

  receive(connection: LiveConnection, message: PreviewSocketMessage) {
    const channel = this.channels.get(message.request_id);
    if (!channel || channel.connection !== connection) return;
    if (message.op === "ready") {
      channel.ready(message.protocol);
      return;
    }
    if (message.op === "close") {
      this.close(message.request_id, false);
      return;
    }
    if (channel.flow) channel.flow.receive(message);
    else if (message.op === "data" && !channel.pending) channel.pending = message;
    else this.close(message.request_id);
  }

  close(id: string, notify = true) {
    const channel = this.channels.get(id);
    if (!channel) return;
    clearTimeout(channel.timer);
    if (channel.flow) channel.flow.close(notify);
    else {
      if (notify) this.send(channel.connection, { op: "close", request_id: id });
      channel.reject(new Error("Preview WebSocket unavailable."));
      this.channels.delete(id);
    }
  }

  drop(connection: LiveConnection) {
    for (const [id, channel] of this.channels) if (channel.connection === connection) this.close(id, false);
  }
}
