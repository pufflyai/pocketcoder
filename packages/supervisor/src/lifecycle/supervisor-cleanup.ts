// Retains original teardown errors while attempting every remaining owned resource closure.
export class SupervisorCleanup {
  private readonly errors: unknown[] = [];

  async attempt(action: () => unknown): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!this.errors.includes(error)) this.errors.push(error);
    }
  }

  get failed() {
    return this.errors.length > 0;
  }

  assertComplete(): void {
    if (this.errors.length) throw new AggregateError(this.errors, "supervisor_cleanup_failed");
  }
}

export async function closeSupervisorResources(actions: {
  closeAdmission(): void;
  cancelStreams(): Promise<void>;
  closeTerminals(): Promise<void>;
  joinWork(): Promise<void>;
  joinOutput(): Promise<unknown>;
  closeConnection(): Promise<void>;
}) {
  const cleanup = new SupervisorCleanup();
  await cleanup.attempt(() => actions.closeAdmission());
  await cleanup.attempt(() => actions.cancelStreams());
  await cleanup.attempt(() => actions.closeTerminals());
  await cleanup.attempt(() => actions.joinWork());
  await cleanup.attempt(() => actions.joinOutput());
  // The transport must remain open until original failure and lifecycle frames flush.
  await Bun.sleep(250);
  await cleanup.attempt(() => actions.closeConnection());
  cleanup.assertComplete();
}
