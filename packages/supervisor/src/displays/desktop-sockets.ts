import { createConnection } from "node:net";
import {
  type ExecSpec,
  PREVIEW_FRAME_BYTES,
  type PreviewQueueBudget,
  PreviewSocketFlow,
  type PreviewSocketMessage,
} from "@pstdio/pocketcoder-contracts";

export class DesktopSockets {
  private readonly sockets = new Map<string, PreviewSocketFlow>();
  constructor(
    private readonly exec: () => ExecSpec | null,
    private readonly send: (message: PreviewSocketMessage) => void,
    private readonly budget: PreviewQueueBudget,
  ) {}

  receive(message: PreviewSocketMessage) {
    if (message.op !== "open") {
      this.sockets.get(message.request_id)?.receive(message);
      return;
    }
    if (this.exec()?.display?.mode !== "desktop" || this.sockets.size >= 5 || this.sockets.has(message.request_id)) {
      this.send({ op: "close", request_id: message.request_id });
      return;
    }
    const socket = createConnection({ host: "127.0.0.1", port: 5900 });
    const flow = new PreviewSocketFlow(
      message.request_id,
      {
        send: (data) => {
          socket.write(data);
        },
        close: () => socket.destroy(),
        bufferedAmount: () => socket.writableLength,
      },
      this.send,
      this.budget,
      () => this.sockets.delete(message.request_id),
    );
    this.sockets.set(message.request_id, flow);
    socket.setTimeout(10_000, () => flow.close());
    socket.on("connect", () => {
      socket.setTimeout(0);
      this.send({ op: "ready", request_id: message.request_id, protocol: "" });
    });
    socket.on("data", (bytes) => {
      if (typeof bytes === "string") throw new Error("Desktop TCP requires binary data.");
      for (let offset = 0; offset < bytes.length; offset += PREVIEW_FRAME_BYTES)
        flow.output(new Uint8Array(bytes.subarray(offset, offset + PREVIEW_FRAME_BYTES)));
    });
    socket.on("close", () => flow.close());
    socket.on("error", () => flow.close());
  }

  owns(id: string) {
    return this.sockets.has(id);
  }
  closeAll() {
    for (const flow of this.sockets.values()) flow.close();
  }
}
