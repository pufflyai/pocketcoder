export {
	type AdmissionLimits,
	type ConnectionHub,
	DEFAULT_LIMITS,
	decodeFailureLogTail,
	type SchedulerDeps,
	type SecretFactory,
} from "./scheduler-base";

import { SchedulerAdmission } from "./scheduler-admission";

export class Scheduler extends SchedulerAdmission {
	tick(): Promise<void> {
		if (this.activeTick) return this.activeTick;
		this.activeTick = this.runTick().finally(() => {
			this.activeTick = null;
		});
		return this.activeTick;
	}

	private async runTick(): Promise<void> {
		await this.sweep();
		await this.admit();
	}
}
