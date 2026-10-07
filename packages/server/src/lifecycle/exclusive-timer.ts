// Owns one non-overlapping controller timer until every admitted task settles.
export function startExclusiveTimer(
  intervalMs: number,
  task: () => Promise<void>,
  errorContext: string,
  log: (message: string) => void,
) {
  let active: Promise<void> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || active) return;
    const running = Promise.resolve().then(task);
    active = running;
    void running
      .catch((error) => log(`${errorContext}: ${String(error)}`))
      .finally(() => {
        if (active === running) active = null;
      });
  }, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
