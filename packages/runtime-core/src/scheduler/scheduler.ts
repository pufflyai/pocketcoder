export {
  type AdmissionLimits,
  type ConnectionHub,
  DEFAULT_LIMITS,
  decodeFailureLogTail,
  type SchedulerDeps,
  type SecretFactory,
} from "./scheduler-base";

import { SchedulerAdmission } from "./scheduler-admission";
import type { SchedulerDeps } from "./scheduler-base";
import { SchedulerContext } from "./scheduler-base";
import { SchedulerLifecycle } from "./scheduler-lifecycle";
import { SchedulerSweep } from "./scheduler-sweep";

export class Scheduler {
  constructor(deps: SchedulerDeps) {
    this.context = new SchedulerContext(deps);
    this.lifecycle = new SchedulerLifecycle(this.context);
    this.sweeper = new SchedulerSweep(this.context, this.lifecycle);
    this.admission = new SchedulerAdmission(this.context);
    this.beginTermination = (...args) => this.context.operations.run(() => this.lifecycle.beginTermination(...args));
    this.finalize = (...args) => this.context.operations.run(() => this.lifecycle.finalize(...args));
    this.fail = (...args) => this.context.operations.run(() => this.lifecycle.fail(...args));
    this.handleProcessExit = (...args) => this.context.operations.run(() => this.lifecycle.handleProcessExit(...args));
    this.sweep = (...args) => this.context.operations.run(() => this.sweeper.sweep(...args));
    this.admit = (...args) => this.context.operations.run(() => this.admission.admit(...args));
  }
  private readonly admission: SchedulerAdmission;

  private readonly sweeper: SchedulerSweep;

  private readonly lifecycle: SchedulerLifecycle;

  private readonly context: SchedulerContext;

  tick(): Promise<void> {
    return this.context.operations.run(() => {
      if (this.context.activeTick) return this.context.activeTick;
      this.context.activeTick = this.runTick().finally(() => {
        this.context.activeTick = null;
      });
      return this.context.activeTick;
    });
  }

  async drain(): Promise<void> {
    await this.context.activeTick;
  }

  close(): Promise<void> {
    return this.context.operations.close();
  }

  private async runTick(): Promise<void> {
    await this.sweeper.sweep();
    await this.admission.admit();
  }

  readonly beginTermination: SchedulerLifecycle["beginTermination"];

  readonly finalize: SchedulerLifecycle["finalize"];

  readonly fail: SchedulerLifecycle["fail"];

  readonly handleProcessExit: SchedulerLifecycle["handleProcessExit"];

  readonly sweep: SchedulerSweep["sweep"];

  readonly admit: SchedulerAdmission["admit"];
}
