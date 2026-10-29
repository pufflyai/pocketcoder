import { PREVIEW_FRAME_BYTES, PREVIEW_QUEUE_BYTES, type PreviewSocketMessage } from "./preview";

export class PreviewQueueBudget {
  private bytes = 0;
  reserve(bytes: number) {
    this.bytes += bytes;
    return this.bytes <= PREVIEW_QUEUE_BYTES;
  }
  release(bytes: number) {
    this.bytes -= bytes;
  }
}

export interface PreviewSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  bufferedAmount(): number;
}

export class PreviewSocketFlow {
  private readonly queue: Array<{ bytes: Uint8Array; binary: boolean }> = [];
  private pending: { bytes: Uint8Array; binary: boolean } | undefined;
  private sequence = 0;
  private expected = 0;
  private receiving = false;
  private ended = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    private readonly socket: PreviewSocket,
    private readonly send: (message: PreviewSocketMessage) => void,
    private readonly budget: PreviewQueueBudget,
    private readonly onClose: () => void,
  ) {}

  output(raw: string | Uint8Array) {
    if (this.ended) return;
    const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
    // Charge for each queued object as well as its payload, including empty messages.
    const reserved = this.budget.reserve(bytes.length + 256);
    this.queue.push({ bytes, binary: typeof raw !== "string" });
    if (bytes.length > PREVIEW_FRAME_BYTES || !reserved) {
      this.close();
      return;
    }
    this.flush();
  }

  receive(message: PreviewSocketMessage) {
    if (this.ended) return;
    if (message.op === "close") {
      this.close(false);
      return;
    }
    if (message.op === "ack") {
      if (!this.pending || message.seq !== this.sequence) {
        this.close();
        return;
      }
      clearTimeout(this.ackTimer);
      this.budget.release(this.pending.bytes.length + 256);
      this.pending = undefined;
      this.sequence++;
      this.flush();
    }
    if (message.op !== "data") return;
    const bytes = Buffer.from(message.content_b64, "base64");
    if (this.receiving || message.seq !== this.expected || bytes.length > PREVIEW_FRAME_BYTES) {
      this.close();
      return;
    }
    this.receiving = true;
    this.socket.send(message.binary ? bytes : bytes.toString());
    const started = Date.now();
    const acknowledge = () => {
      if (this.ended) return;
      if (Date.now() - started > 30_000 || this.socket.bufferedAmount() > PREVIEW_QUEUE_BYTES) {
        this.close();
        return;
      }
      if (this.socket.bufferedAmount() > 0) {
        this.timer = setTimeout(acknowledge, 10);
        return;
      }
      this.receiving = false;
      this.expected++;
      this.send({ op: "ack", request_id: this.id, seq: message.seq });
    };
    acknowledge();
  }

  close(notify = true) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    clearTimeout(this.ackTimer);
    for (const item of this.queue) this.budget.release(item.bytes.length + 256);
    if (this.pending) this.budget.release(this.pending.bytes.length + 256);
    this.queue.length = 0;
    this.pending = undefined;
    if (notify) this.send({ op: "close", request_id: this.id });
    this.socket.close();
    this.onClose();
  }

  private flush() {
    if (this.pending || this.ended) return;
    this.pending = this.queue.shift();
    if (!this.pending) return;
    this.ackTimer = setTimeout(() => this.close(), 30_000);
    this.ackTimer.unref();
    this.send({
      op: "data",
      request_id: this.id,
      seq: this.sequence,
      binary: this.pending.binary,
      content_b64: Buffer.from(this.pending.bytes).toString("base64"),
    });
  }
}
