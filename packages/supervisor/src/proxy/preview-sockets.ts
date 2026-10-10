import {
  type ExecSpec,
  PreviewQueueBudget,
  PreviewSocketFlow,
  type PreviewSocketMessage,
  previewTarget,
} from "@pstdio/pocketcoder-contracts";
import { DesktopSockets } from "../displays/desktop-sockets";

export class SupervisorPreviewSockets {
  private readonly sockets = new Map<
    string,
    { socket: WebSocket; flow: PreviewSocketFlow; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly budget = new PreviewQueueBudget();
  private readonly desktop: DesktopSockets;

  constructor(
    private readonly exec: () => ExecSpec | null,
    private readonly send: (message: PreviewSocketMessage) => void,
  ) {
    this.desktop = new DesktopSockets(exec, send, this.budget);
  }

  receive(message: PreviewSocketMessage) {
    if ((message.op === "open" && message.name === "display") || this.desktop.owns(message.request_id)) {
      this.desktop.receive(message);
      return;
    }
    if (message.op !== "open") {
      this.sockets.get(message.request_id)?.flow.receive(message);
      return;
    }
    const preview = this.exec()?.previews?.[message.name];
    if (!preview || this.sockets.size >= 64 || this.sockets.has(message.request_id)) {
      this.send({ op: "close", request_id: message.request_id });
      return;
    }
    const url = previewTarget(preview.port, message.path);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { origin: message.origin, ...(message.cookie ? { cookie: message.cookie } : {}) },
      protocols: message.protocols,
    } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const flow = new PreviewSocketFlow(
      message.request_id,
      {
        send: (data) => socket.send(data),
        close: () => socket.close(),
        bufferedAmount: () => socket.bufferedAmount,
      },
      this.send,
      this.budget,
      () => {
        clearTimeout(this.sockets.get(message.request_id)?.timer);
        this.sockets.delete(message.request_id);
      },
    );
    const timer = setTimeout(() => flow.close(), 10_000);
    timer.unref();
    this.sockets.set(message.request_id, { socket, flow, timer });
    socket.onopen = () => {
      clearTimeout(timer);
      this.send({ op: "ready", request_id: message.request_id, protocol: socket.protocol });
    };
    socket.onmessage = (event) =>
      flow.output(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = () => flow.close();
    socket.onerror = () => flow.close();
  }

  closeAll() {
    this.desktop.closeAll();
    for (const { flow } of this.sockets.values()) flow.close();
  }
}
