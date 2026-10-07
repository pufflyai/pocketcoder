// Joins actual supervisor work and preserves an admitted failure before removing its promise.
export class SupervisorWork {
  private readonly pending = new Set<Promise<unknown>>();
  private failure: { error: unknown } | null = null;

  run<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    void operation.then(
      () => {
        this.pending.delete(operation);
      },
      (error) => {
        this.failure ??= { error };
        this.pending.delete(operation);
      },
    );
    return operation;
  }

  async join(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.failure) throw new AggregateError([this.failure.error], "supervisor_work_failed");
  }
}
