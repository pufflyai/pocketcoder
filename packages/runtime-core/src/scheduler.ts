import {
	type ProviderInput,
	parseDurationMs,
	type ReasonCode,
	type WorkspaceState,
} from "@pocketcoder/contracts";
import type { WorkspaceDriver } from "./driver";
import type { ActiveCounts, Store, WorkspaceRow } from "./types";

// Admission, expiry, and termination. One logical execution path: queued
// workspaces launch through the configured driver in fair FIFO order within
// principal/template/global capacity. Capacity pressure queues work; it never
// routes to a shared executor.

export interface AdmissionLimits {
	globalActiveWorkspaces: number;
	perPrincipalActiveWorkspaces: number;
	perTemplateActiveWorkspaces: Record<string, number>;
	maxQueuedWorkspaces: number;
	maxQueueAgeMs: number;
	maxLaunchAttempts: number;
}

export const DEFAULT_LIMITS: AdmissionLimits = {
	globalActiveWorkspaces: 100,
	perPrincipalActiveWorkspaces: 20,
	perTemplateActiveWorkspaces: {},
	maxQueuedWorkspaces: 1000,
	maxQueueAgeMs: 30 * 60_000,
	maxLaunchAttempts: 3,
};

// The live-connection surface the scheduler needs; implemented by the
// server's WSS hub. It reports nothing durable.
export interface ConnectionHub {
	isConnected(workspaceId: string): boolean;
	shutdown(workspaceId: string, reason: string): boolean;
	signal(workspaceId: string, signal: "TERM" | "KILL"): boolean;
	close(workspaceId: string): void;
}

export interface SecretFactory {
	generate(): string;
	digest(secret: string): Uint8Array;
}

export interface SchedulerDeps {
	store: Store;
	driver: WorkspaceDriver;
	connections: ConnectionHub;
	secrets: SecretFactory;
	limits: AdmissionLimits;
	// URL workspaces use to reach this server (may differ from listen addr).
	workspaceServerUrl: string;
	now?: () => Date;
	onError?: (context: string, err: unknown) => void;
}

export class Scheduler {
	private readonly deps: SchedulerDeps;
	private lastAdmittedPrincipal: string | null = null;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private report(context: string, err: unknown): void {
		this.deps.onError?.(context, err);
	}

	async tick(): Promise<void> {
		await this.sweep();
		await this.admit();
	}

	private timeoutMs(
		row: WorkspaceRow,
		key: "start" | "maxAge" | "idle" | "disconnectGrace" | "terminateGrace",
	): number {
		return parseDurationMs(row.templateSnapshot.spec.timeouts[key]);
	}

	private graceSeconds(row: WorkspaceRow): number {
		return Math.max(1, Math.ceil(this.timeoutMs(row, "terminateGrace") / 1000));
	}

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

	private async sweepRow(row: WorkspaceRow, now: Date): Promise<void> {
		const { store } = this.deps;
		if (row.state === "queued") {
			if (now.getTime() - row.createdAt.getTime() > this.deps.limits.maxQueueAgeMs) {
				await store.transition(row.id, {
					from: ["queued"],
					to: "expired",
					reason: "queue_timeout",
					at: now,
				});
				return;
			}
			if (now >= row.deadlineAt) {
				await store.transition(row.id, {
					from: ["queued"],
					to: "expired",
					reason: "deadline_expired",
					at: now,
				});
			}
			return;
		}
		if (row.state === "provisioning") {
			if (row.registrationExpiresAt && now >= row.registrationExpiresAt) {
				await this.fail(row, "registration_timeout", now);
			}
			return;
		}
		if (row.state === "connected" || row.state === "ready") {
			if (now >= row.deadlineAt) {
				await this.beginTermination(row, "expired", "deadline_expired", now);
				return;
			}
			if (
				row.state === "ready" &&
				row.lastActivityAt &&
				now.getTime() - row.lastActivityAt.getTime() > this.timeoutMs(row, "idle")
			) {
				await this.beginTermination(row, "expired", "idle_expired", now);
				return;
			}
			if (
				row.disconnectedAt &&
				!this.deps.connections.isConnected(row.id) &&
				now.getTime() - row.disconnectedAt.getTime() > this.timeoutMs(row, "disconnectGrace")
			) {
				await this.fail(row, "disconnect_timeout", now);
			}
			return;
		}
		if (row.state === "terminating") {
			// Enforce with the provider if the agent has not exited within a
			// few grace periods.
			const stuckMs = 4 * this.timeoutMs(row, "terminateGrace") + 5000;
			if (now.getTime() - row.updatedAt.getTime() > stuckMs) {
				await this.finalize(
					row,
					(row.terminalIntent ?? "failed") as WorkspaceState,
					row.reasonCode,
					now,
				);
			}
		}
	}

	// Cancel/expiry entry point shared with the API: move to `terminating`,
	// ask the agent to stop, and enforce through the driver.
	async beginTermination(
		row: WorkspaceRow,
		terminalState: WorkspaceState,
		reason: ReasonCode,
		at: Date,
	): Promise<WorkspaceRow | null> {
		const { store, connections, driver } = this.deps;
		const updated = await store.transition(row.id, {
			from: ["provisioning", "connected", "ready"],
			to: "terminating",
			reason,
			at,
			patch: { terminalIntent: terminalState },
		});
		if (!updated) {
			return null;
		}
		const connected = connections.isConnected(row.id);
		if (connected) {
			connections.shutdown(row.id, reason);
			connections.signal(row.id, "TERM");
		}
		if (updated.providerRef) {
			// docker stop / Job deletion performs TERM, grace, KILL.
			driver
				.terminate(
					{ kind: updated.providerKind ?? "", id: "", ...updated.providerRef },
					this.graceSeconds(updated),
				)
				.then(() => this.finalize(updated, terminalState, reason, this.now()))
				.catch((err) => this.report(`terminate.${row.id}`, err));
		} else {
			await this.finalize(updated, terminalState, reason, at);
		}
		return updated;
	}

	async finalize(
		row: WorkspaceRow,
		terminalState: WorkspaceState,
		reason: ReasonCode | null,
		at: Date,
	): Promise<void> {
		const { store, driver, connections } = this.deps;
		if (row.providerRef) {
			try {
				await driver.terminate(
					{ kind: row.providerKind ?? "", id: "", ...row.providerRef },
					this.graceSeconds(row),
				);
			} catch (err) {
				this.report(`finalize.terminate.${row.id}`, err);
			}
		}
		connections.close(row.id);
		await store.transition(row.id, {
			from: ["queued", "provisioning", "connected", "ready", "terminating"],
			to: terminalState,
			reason,
			at,
			patch: { launchInput: null, registrationDigest: null },
		});
	}

	async fail(row: WorkspaceRow, reason: ReasonCode, at: Date): Promise<void> {
		await this.finalize(row, "failed", reason, at);
	}

	async admit(): Promise<void> {
		const { store, limits } = this.deps;
		let counts: ActiveCounts;
		let queued: WorkspaceRow[];
		try {
			counts = await store.countActive();
			queued = await store.listQueued(200);
		} catch (err) {
			this.report("admit.list", err);
			return;
		}
		if (queued.length === 0) {
			return;
		}
		// FIFO within a principal, round-robin across principals.
		const byPrincipal = new Map<string, WorkspaceRow[]>();
		for (const row of queued) {
			const list = byPrincipal.get(row.principalId) ?? [];
			list.push(row);
			byPrincipal.set(row.principalId, list);
		}
		const principals = [...byPrincipal.keys()];
		const startIdx = this.lastAdmittedPrincipal
			? (principals.indexOf(this.lastAdmittedPrincipal) + 1) % principals.length
			: 0;
		const rotation = [...principals.slice(startIdx), ...principals.slice(0, startIdx)];

		let progressed = true;
		while (progressed && counts.global < limits.globalActiveWorkspaces) {
			progressed = false;
			for (const principalId of rotation) {
				if (counts.global >= limits.globalActiveWorkspaces) {
					break;
				}
				const list = byPrincipal.get(principalId);
				const row = list?.[0];
				if (!row) {
					continue;
				}
				const principalActive = counts.byPrincipal[principalId] ?? 0;
				if (principalActive >= limits.perPrincipalActiveWorkspaces) {
					continue;
				}
				const templateLimit =
					limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
				if ((counts.byTemplate[row.templateName] ?? 0) >= templateLimit) {
					continue;
				}
				list?.shift();
				const launched = await this.launch(row);
				if (launched) {
					counts.global += 1;
					counts.byPrincipal[principalId] = principalActive + 1;
					counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + 1;
					this.lastAdmittedPrincipal = principalId;
				}
				progressed = true;
			}
		}
	}

	private async launch(row: WorkspaceRow): Promise<boolean> {
		const { store, driver, secrets } = this.deps;
		const now = this.now();
		const secret = secrets.generate();
		const claimed = await store.transition(row.id, {
			from: ["queued"],
			to: "provisioning",
			at: now,
			patch: {
				registrationDigest: secrets.digest(secret),
				registrationExpiresAt: new Date(now.getTime() + this.timeoutMs(row, "start")),
				launchAttempts: row.launchAttempts + 1,
			},
		});
		if (!claimed) {
			return false;
		}
		const input: ProviderInput = {
			workspace_id: row.id,
			server_url: this.deps.workspaceServerUrl,
			registration_secret: secret,
			template_digest: row.templateDigest,
			template_name: row.templateName,
			template_version: row.templateVersion,
			...(row.launchInput ? { launch_input: row.launchInput } : {}),
		};
		try {
			const ref = await driver.create({ workspace: claimed, input });
			await store.updateWorkspace(
				row.id,
				{ providerKind: driver.kind, providerRef: ref },
				this.now(),
			);
			return true;
		} catch (err) {
			this.report(`launch.${row.id}`, err);
			const at = this.now();
			if (claimed.launchAttempts < this.deps.limits.maxLaunchAttempts) {
				// No provider object was created; the bounded requeue is legal.
				await store.transition(row.id, {
					from: ["provisioning"],
					to: "queued",
					at,
					patch: { registrationDigest: null, registrationExpiresAt: null },
				});
			} else {
				await store.transition(row.id, {
					from: ["provisioning"],
					to: "failed",
					reason: "launch_failed",
					at,
					patch: { launchInput: null, registrationDigest: null },
				});
			}
			return false;
		}
	}
}
