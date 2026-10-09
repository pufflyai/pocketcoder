import { randomUUID } from "node:crypto";

// Setup may leave a credential in user-controlled files. Only the issuer's
// revocation acknowledgement makes it safe to start the harness.
export class SetupCompletion {
  private pending: { requestId: string; resolve: (complete: boolean) => void } | null = null;

  constructor(private readonly send: (requestId: string) => boolean) {}

  async wait(expiresAt: string) {
    const completion = Promise.withResolvers<boolean>();
    const requestId = randomUUID();
    this.pending = { requestId, resolve: completion.resolve };
    const retry = setInterval(() => this.retry(), 1000);
    const timeout = setTimeout(() => completion.resolve(false), Math.max(0, Date.parse(expiresAt) - Date.now()));
    this.retry();
    try {
      return await completion.promise;
    } finally {
      clearInterval(retry);
      clearTimeout(timeout);
      this.pending = null;
    }
  }

  retry() {
    if (this.pending) this.send(this.pending.requestId);
  }

  acknowledge(requestId: string) {
    if (this.pending?.requestId === requestId) this.pending.resolve(true);
  }

  cancel() {
    this.pending?.resolve(false);
  }
}
