import {
  BrowserActionSchema,
  browserFrameChunks,
  type ExecSpec,
  type PreviewQueueBudget,
  PreviewSocketFlow,
  type PreviewSocketMessage,
} from "@pstdio/pocketcoder-contracts";
import { type Chromium, connectChromium } from "./chromium";

export class BrowserSockets {
  private readonly sockets = new Map<string, PreviewSocketFlow>();
  private connection: Promise<Chromium> | undefined;
  private generation: symbol | undefined;
  private lastFrame: Uint8Array | undefined;
  private actions = Promise.resolve();
  private queuedActions = 0;

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
    if (this.exec()?.display?.mode !== "browser" || this.sockets.size >= 5 || this.sockets.has(message.request_id)) {
      this.send({ op: "close", request_id: message.request_id });
      return;
    }
    const flow = new PreviewSocketFlow(
      message.request_id,
      {
        send: (data) => {
          try {
            if (typeof data === "string" || data.length > 4096 || this.queuedActions >= 32)
              throw new Error("Invalid browser action.");
            const action = BrowserActionSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
            );
            this.queuedActions++;
            this.actions = this.actions
              .then(async () => {
                if (!this.sockets.has(message.request_id)) return;
                const browser = await this.connection;
                if (!browser || !this.sockets.has(message.request_id)) return;
                await browser.action(action);
              })
              .catch(() => flow.close())
              .finally(() => {
                this.queuedActions--;
              });
          } catch {
            flow.close();
          }
        },
        close: () => {},
        bufferedAmount: () => 0,
      },
      this.send,
      this.budget,
      () => {
        this.sockets.delete(message.request_id);
        if (!this.sockets.size) this.disconnect();
      },
    );
    this.sockets.set(message.request_id, flow);
    if (!this.connection) {
      const generation = Symbol();
      this.generation = generation;
      this.connection = connectChromium(
        (bytes) => {
          if (this.generation !== generation) return;
          this.lastFrame = bytes;
          for (const chunk of browserFrameChunks(bytes))
            for (const viewer of this.sockets.values()) viewer.output(chunk);
        },
        () => {
          if (this.generation === generation) this.closeAll();
        },
      );
    }
    void this.connection
      .then(() => {
        if (!this.sockets.has(message.request_id)) return;
        this.send({ op: "ready", request_id: message.request_id, protocol: "" });
        if (this.lastFrame) for (const chunk of browserFrameChunks(this.lastFrame)) flow.output(chunk);
      })
      .catch(() => flow.close());
  }

  owns(id: string) {
    return this.sockets.has(id);
  }
  closeAll() {
    for (const flow of this.sockets.values()) flow.close();
    this.disconnect();
  }
  private disconnect() {
    const connection = this.connection;
    this.connection = undefined;
    this.generation = undefined;
    this.lastFrame = undefined;
    void connection?.then(
      (browser) => browser.close(),
      () => {},
    );
  }
}
