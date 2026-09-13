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
    this.beginTermination = this.lifecycle.beginTermination.bind(this.lifecycle);
    this.finalize = this.lifecycle.finalize.bind(this.lifecycle);
    this.fail = this.lifecycle.fail.bind(this.lifecycle);
    this.handleProcessExit = this.lifecycle.handleProcessExit.bind(this.lifecycle);
    this.sweep = this.sweeper.sweep.bind(this.sweeper);
    this.admit = this.admission.admit.bind(this.admission);
  }
  private readonly admission: SchedulerAdmission;

  private readonly sweeper: SchedulerSweep;

  private readonly lifecycle: SchedulerLifecycle;

  private readonly context: SchedulerContext;

  tick(): Promise<void> {
    if (this.context.activeTick) return this.context.activeTick;
    this.context.activeTick = this.runTick().finally(() => {
      this.context.activeTick = null;
    });
    return this.context.activeTick;
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
