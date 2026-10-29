const INTERVAL = 1000 / 15;

export class FramePublisher {
  private latest: Uint8Array | undefined;
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly deliver: (bytes: Uint8Array) => void) {}

  receive(bytes: Uint8Array) {
    this.latest = bytes;
    if (!this.timer) this.schedule();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
  }

  private schedule() {
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (performance.now() - this.last < INTERVAL) {
          this.schedule();
          return;
        }
        const bytes = this.latest;
        this.latest = undefined;
        if (!bytes) return;
        this.last = performance.now();
        this.deliver(bytes);
      },
      Math.max(0, Math.ceil(INTERVAL - (performance.now() - this.last))),
    );
  }
}
