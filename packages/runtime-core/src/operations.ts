// Closes controller dispatch and joins actual admitted work, including detached descendants.

import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "@pstdio/pocketcoder-contracts";

export class RuntimeOperations {
  private readonly context = new AsyncLocalStorage<object>();
  private readonly scopes = new Map<object, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private failure: { error: unknown } | null = null;
  private admitting = true;
  private closing: Promise<void> | null = null;

  run<T>(work: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore();
    if (!this.admitting && (!inherited || !this.scopes.has(inherited))) {
      return Promise.reject(new ApiError("operation.conflict", "controller_admission_closed"));
    }
    const scope = inherited && this.scopes.has(inherited) ? inherited : {};
    this.scopes.set(scope, (this.scopes.get(scope) ?? 0) + 1);
    const operation = this.context.run(scope, () => Promise.resolve().then(work));
    this.pending.add(operation);
    void operation.then(
      () => this.settle(operation, scope),
      (error) => {
        // A caught caller response cannot erase the failure of admitted controller work.
        this.failure ??= { error };
        this.settle(operation, scope);
      },
    );
    return operation;
  }

  connection() {
    if (!this.admitting) throw new ApiError("operation.conflict", "controller_admission_closed");
    const scope = {};
    this.scopes.set(scope, 0);
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifetime = this.context.run(scope, () => this.run(() => closed));
    let finishing: Promise<void> | null = null;
    return {
      dispatch: (work: () => Promise<void>) => {
        if (!this.admitting || finishing)
          return Promise.reject(new ApiError("operation.conflict", "controller_admission_closed"));
        return this.context.run(scope, () => this.run(work));
      },
      finish: (work: () => Promise<void>) => {
        finishing ??= this.context.run(scope, () => this.run(work)).finally(release);
        return finishing;
      },
      lifetime,
    };
  }

  assertControlCaller(): void {
    const scope = this.context.getStore();
    if (scope && this.scopes.has(scope)) throw new Error("controller_control_reentrancy");
  }

  close(): Promise<void> {
    this.assertControlCaller();
    this.admitting = false;
    this.closing ??= this.join();
    return this.closing;
  }

  private settle(operation: Promise<unknown>, scope: object) {
    this.pending.delete(operation);
    const remaining = (this.scopes.get(scope) ?? 1) - 1;
    if (remaining) this.scopes.set(scope, remaining);
    else this.scopes.delete(scope);
  }

  private async join() {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
    if (this.failure) throw new AggregateError([this.failure.error], "controller_work_failed");
  }
}
