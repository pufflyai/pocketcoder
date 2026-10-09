import type { openCheckpointSourceFile } from "./source-file";

interface PayloadOptions {
  signal?: AbortSignal;
  check(): void;
  onClose(): void | Promise<void>;
}

export function createCheckpointSourcePayload(
  file: ReturnType<typeof openCheckpointSourceFile>,
  options: PayloadOptions,
) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let settled = false;
  let closing: Promise<void> | undefined;

  function refuse(reason: unknown) {
    if (settled) return;
    settled = true;
    controller.error(reason);
  }

  function drain() {
    stopped = true;
    closing ??= (async () => {
      try {
        try {
          await file.close();
        } finally {
          await options.onClose();
        }
      } finally {
        options.signal?.removeEventListener("abort", aborted);
      }
    })();
    return closing;
  }

  function close(reason: unknown = new Error("Checkpoint payload is closed.")) {
    refuse(reason);
    return drain();
  }

  function aborted() {
    void close(options.signal?.reason).catch(() => {});
  }

  function checkStopped() {
    options.signal?.throwIfAborted();
    if (stopped) throw new Error("Checkpoint payload is closed.");
  }

  function validate() {
    checkStopped();
    options.check();
    checkStopped();
    file.validate();
    checkStopped();
  }

  async function pull() {
    try {
      validate();
      const chunk = await file.read();
      validate();
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      await drain();
      options.signal?.throwIfAborted();
      if (!settled) {
        settled = true;
        controller.close();
      }
    } catch (error) {
      refuse(error);
      await drain().catch(() => {});
    }
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
      },
      pull,
      cancel(reason) {
        settled = true;
        return close(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, close };
}
