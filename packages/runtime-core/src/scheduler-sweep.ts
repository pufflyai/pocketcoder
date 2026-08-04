import type { WorkspaceState } from "@pstdio/pocketcoder-contracts";
import { SchedulerLifecycle } from "./scheduler-lifecycle";
import type { WorkspaceRow } from "./types";

export class SchedulerSweep extends SchedulerLifecycle {
	async sweep(): Promise<void> {
		const now = this.now();
		let rows: WorkspaceRow[];
		try {
			rows = await this.deps.store.listNonterminal();
		} catch (err) {
			this.report("sweep.list", err);
			return;
		}
		for (const row of rows) {
			try {
				await this.sweepRow(row, now);
			} catch (err) {
				this.report(`sweep.${row.id}`, err);
			}
		}
	}

	protected async sweepQueued(row: WorkspaceRow, now: Date): Promise<void> {
		const queueAge = now.getTime() - row.createdAt.getTime();
		if (queueAge > this.deps.limits.maxQueueAgeMs) {
			await this.deps.store.transition(row.id, {
				from: ["queued"],
				to: "expired",
				reason: "queue_timeout",
				at: now,
			});
			return;
		}
		if (now >= row.deadlineAt) {
			await this.deps.store.transition(row.id, {
				from: ["queued"],
				to: "expired",
				reason: "deadline_expired",
				at: now,
			});
		}
	}

	protected async sweepActive(row: WorkspaceRow, now: Date): Promise<void> {
		if (now >= row.deadlineAt) {
			const preserve =
				row.templateSnapshot.spec.persistence.checkpoint.onDeadline === "preserve" &&
				(await this.requestPolicyPreserve(row, "deadline"));
			if (!preserve) {
				await this.beginTermination(row, "expired", "deadline_expired", now);
			}
			return;
		}
		const idle =
			row.state === "ready" &&
			row.lastActivityAt !== null &&
			now.getTime() - row.lastActivityAt.getTime() > this.timeoutMs(row, "idle");
		if (idle) {
			const preserve =
				row.templateSnapshot.spec.persistence.checkpoint.onIdle === "preserve" &&
				(await this.requestPolicyPreserve(row, "idle"));
			if (!preserve) {
				await this.beginTermination(row, "expired", "idle_expired", now);
			}
			return;
		}
		const disconnectedTooLong =
			row.disconnectedAt !== null &&
			!this.deps.connections.isConnected(row.id) &&
			now.getTime() - row.disconnectedAt.getTime() > this.timeoutMs(row, "disconnectGrace");
		if (disconnectedTooLong) await this.fail(row, "disconnect_timeout", now);
	}

	protected async sweepTerminating(row: WorkspaceRow, now: Date): Promise<void> {
		// Enforce with the provider if the agent has not exited within a few
		// grace periods.
		const stuckMs = 4 * this.timeoutMs(row, "terminateGrace") + 5000;
		if (now.getTime() - row.updatedAt.getTime() <= stuckMs) return;
		await this.finalize(
			row,
			(row.terminalIntent ?? "failed") as WorkspaceState,
			row.reasonCode,
			now,
		);
	}

	protected async sweepRow(row: WorkspaceRow, now: Date): Promise<void> {
		switch (row.state) {
			case "queued":
				await this.sweepQueued(row, now);
				return;
			case "provisioning":
				if (row.registrationExpiresAt && now >= row.registrationExpiresAt) {
					if (
						row.provisioningMode === "warm" &&
						row.launchAttempts < this.deps.limits.maxLaunchAttempts
					) {
						if (row.providerRef) {
							await this.deps.driver.stop(row.providerRef as never, 1).catch(() => {});
							await this.deps.driver.remove(row.providerRef as never).catch(() => {});
						}
						await this.deps.store.transition(row.id, {
							from: ["provisioning"],
							to: "queued",
							at: now,
							patch: {
								providerKind: null,
								providerRef: null,
								provisioningMode: null,
								registrationDigest: null,
								registrationExpiresAt: null,
							},
						});
					} else {
						await this.fail(row, "registration_timeout", now);
					}
				}
				return;
			case "connected":
			case "ready":
				await this.sweepActive(row, now);
				return;
			case "terminating":
				await this.sweepTerminating(row, now);
				return;
			case "preserving":
				return;
		}
	}

	// Cancel/expiry entry point shared with the API: move to `terminating`,
	// ask the agent to stop, and enforce through the driver.
}
