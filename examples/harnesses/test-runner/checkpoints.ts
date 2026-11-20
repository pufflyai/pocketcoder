// A separate object holds partial evidence, so an interrupted upload cannot replace final evidence.
export function startCheckpoints(upload: (signal: AbortSignal) => Promise<unknown>, intervalMs = 30_000) {
  const controller = new AbortController();
  const errors: string[] = [];
  let pending: Promise<void> | undefined;
  const capture = () => {
    if (pending || controller.signal.aborted) return;
    pending = upload(AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
      .then(() => {})
      .catch((error) => {
        if (!controller.signal.aborted) errors.push(String(error).slice(0, 8192));
      })
      .finally(() => {
        pending = undefined;
      });
  };
  capture();
  const timer = setInterval(capture, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      controller.abort();
      await pending;
      return errors;
    },
  };
}
