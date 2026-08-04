import { randomUUID } from "node:crypto";
import { redact } from "@pstdio/pocketcoder-auth";
import {
	type ProviderInput,
	parseDurationMs,
	type ReasonCode,
	type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import type {
	RuntimeMountRef,
	StorageRef,
	WorkspaceDriver,
	WorkspaceSecretResolver,
	WorkspaceStorageDriver,
} from "./driver";
import type {
	ActiveCounts,
	LogStore,
	PersistenceStore,
	WorkspacePatch,
	WorkspaceRow,
	WorkspaceStore,
} from "./types";
import type { WarmPoolManager } from "./warm-pool";

const FAILURE_LOG_TAIL_BYTES = 16 * 1024;

export function decodeFailureLogTail(content: Uint8Array, truncated: boolean): string {
	let start = 0;
	if (truncated) {
		while (start < content.byteLength && ((content[start] as number) & 0xc0) === 0x80) {
			start += 1;
		}
	}
	let text = new TextDecoder().decode(content.subarray(start));
	if (truncated) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
	}
	return redact(text);
}

function failureLogContent(error: unknown): Uint8Array {
	const message = redact(error instanceof Error ? error.message : String(error));
	const encoded = new TextEncoder().encode(`workspace launch failed: ${message}\n`);
	if (encoded.byteLength <= FAILURE_LOG_TAIL_BYTES) return encoded;
	const bounded = encoded.subarray(0, FAILURE_LOG_TAIL_BYTES - 1);
	return new TextEncoder().encode(`${new TextDecoder().decode(bounded).replace(/\uFFFD$/, "")}\n`);
}

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
	store: WorkspaceStore & PersistenceStore & LogStore;
	driver: WorkspaceDriver;
	storageDriver?: WorkspaceStorageDriver;
	secretResolver?: WorkspaceSecretResolver;
	connections: ConnectionHub;
	secrets: SecretFactory;
	limits: AdmissionLimits;
	// URL workspaces use to reach this server (may differ from listen addr).
	workspaceServerUrl: string;
	warmPool?: WarmPoolManager;
	preserveByPolicy?: (
		row: WorkspaceRow,
		trigger: "idle" | "deadline" | "clean_exit" | "failure",
	) => Promise<boolean>;
	now?: () => Date;
	onError?: (context: string, err: unknown) => void;
}

export class Scheduler {
	private readonly deps: SchedulerDeps;
	private lastAdmittedPrincipal: string | null = null;
	private activeTick: Promise<void> | null = null;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private report(context: string, err: unknown): void {
		this.deps.onError?.(context, err);
	}

	private async captureLaunchFailure(
		workspaceId: string,
		error: unknown,
		at: Date,
	): Promise<WorkspacePatch> {
		const { store } = this.deps;
		try {
			await store.appendLogs(workspaceId, [
				{
					stream: "runtime",
					occurredAt: at,
					content: failureLogContent(error),
				},
			]);
			const tail = await store.readLogTail(workspaceId, FAILURE_LOG_TAIL_BYTES);
			return {
				failureLogTail: decodeFailureLogTail(tail.content, tail.truncated),
				failureLogTailTruncated: tail.truncated,
				failureLastLogSeq: tail.lastSeq,
			};
		} catch (captureError) {
			this.report(`launch.log.${workspaceId}`, captureError);
			return {};
		}
	}

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

	private async sweepQueued(row: WorkspaceRow, now: Date): Promise<void> {
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

	private async sweepActive(row: WorkspaceRow, now: Date): Promise<void> {
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

	private async sweepTerminating(row: WorkspaceRow, now: Date): Promise<void> {
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

	private async sweepRow(row: WorkspaceRow, now: Date): Promise<void> {
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
	async beginTermination(
		row: WorkspaceRow,
		terminalState: WorkspaceState,
		reason: ReasonCode,
		at: Date,
	): Promise<WorkspaceRow | null> {
		const { store, connections } = this.deps;
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
			this.stopAndRemove(
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
		retainStorage = false,
	): Promise<void> {
		const { store, driver, connections } = this.deps;
		if (row.providerRef) {
			try {
				await driver.stop(
					{ kind: row.providerKind ?? "", id: "", ...row.providerRef },
					this.graceSeconds(row),
				);
				await driver.remove({
					kind: row.providerKind ?? "",
					id: "",
					...row.providerRef,
				});
			} catch (err) {
				this.report(`finalize.terminate.${row.id}`, err);
			}
		}
		if (retainStorage) {
			const storage = await store.getWorkspaceStorage(row.id);
			if (storage && !["retained", "deleted"].includes(storage.state)) {
				await store.updateWorkspaceStorage(
					storage.id,
					{
						state: "retained",
						retainedUntil: new Date(
							at.getTime() +
								parseDurationMs(row.templateSnapshot.spec.persistence.checkpoint.retention),
						),
					},
					at,
				);
			}
		} else {
			await this.cleanupWorkspaceStorage(row);
		}
		let failurePatch: WorkspacePatch = {};
		if (terminalState === "failed") {
			try {
				const tail = await store.readLogTail(row.id, FAILURE_LOG_TAIL_BYTES);
				failurePatch = {
					failureLogTail: decodeFailureLogTail(tail.content, tail.truncated),
					failureLogTailTruncated: tail.truncated,
					failureLastLogSeq: tail.lastSeq,
				};
			} catch (error) {
				this.report(`finalize.log-tail.${row.id}`, error);
			}
		}
		connections.close(row.id);
		await store.transition(row.id, {
			from: ["queued", "provisioning", "connected", "ready", "terminating"],
			to: terminalState,
			reason,
			at,
			patch: {
				launchInput: null,
				registrationDigest: null,
				...failurePatch,
			},
		});
	}

	private async stopAndRemove(
		ref: { kind: string; id: string; [key: string]: unknown },
		graceSeconds: number,
	): Promise<void> {
		await this.deps.driver.stop(ref, graceSeconds);
		await this.deps.driver.remove(ref);
	}

	async fail(row: WorkspaceRow, reason: ReasonCode, at: Date): Promise<void> {
		const action = row.templateSnapshot.spec.persistence.checkpoint.onFailure;
		if (
			action === "preserve" &&
			["connected", "ready"].includes(row.state) &&
			(await this.requestPolicyPreserve(row, "failure"))
		) {
			return;
		}
		await this.finalize(row, "failed", reason, at, action === "retain-for-recovery");
	}

	async handleProcessExit(row: WorkspaceRow, exitCode: number | null, at: Date): Promise<void> {
		if (
			exitCode === 0 &&
			row.templateSnapshot.spec.persistence.checkpoint.onCleanExit === "preserve" &&
			(await this.requestPolicyPreserve(row, "clean_exit"))
		) {
			return;
		}
		if (exitCode !== 0) {
			await this.fail(row, "child_exit_failure", at);
			return;
		}
		await this.finalize(row, "succeeded", "child_exit_success", at);
	}

	private async requestPolicyPreserve(
		row: WorkspaceRow,
		trigger: "idle" | "deadline" | "clean_exit" | "failure",
	): Promise<boolean> {
		if (row.templateSnapshot.spec.persistence.mounts.length === 0 || !this.deps.preserveByPolicy) {
			return false;
		}
		try {
			return await this.deps.preserveByPolicy(row, trigger);
		} catch (error) {
			this.report(`preserve-policy.${trigger}.${row.id}`, error);
			return false;
		}
	}

	private groupQueuedByPrincipal(queued: WorkspaceRow[]): Map<string, WorkspaceRow[]> {
		const byPrincipal = new Map<string, WorkspaceRow[]>();
		for (const row of queued) {
			const list = byPrincipal.get(row.principalId) ?? [];
			list.push(row);
			byPrincipal.set(row.principalId, list);
		}
		return byPrincipal;
	}

	private principalRotation(byPrincipal: Map<string, WorkspaceRow[]>): string[] {
		const principals = [...byPrincipal.keys()];
		const startIndex = this.lastAdmittedPrincipal
			? (principals.indexOf(this.lastAdmittedPrincipal) + 1) % principals.length
			: 0;
		return [...principals.slice(startIndex), ...principals.slice(0, startIndex)];
	}

	private canAdmit(row: WorkspaceRow, counts: ActiveCounts): boolean {
		const { limits } = this.deps;
		const principalActive = counts.byPrincipal[row.principalId] ?? 0;
		if (principalActive >= limits.perPrincipalActiveWorkspaces) return false;
		const templateLimit =
			limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
		return (counts.byTemplate[row.templateName] ?? 0) < templateLimit;
	}

	private recordAdmission(row: WorkspaceRow, counts: ActiveCounts): void {
		counts.global += 1;
		counts.byPrincipal[row.principalId] = (counts.byPrincipal[row.principalId] ?? 0) + 1;
		counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + 1;
		this.lastAdmittedPrincipal = row.principalId;
	}

	private async admitRound(
		byPrincipal: Map<string, WorkspaceRow[]>,
		rotation: string[],
		counts: ActiveCounts,
	): Promise<boolean> {
		let progressed = false;
		for (const principalId of rotation) {
			if (counts.global >= this.deps.limits.globalActiveWorkspaces) break;
			const list = byPrincipal.get(principalId);
			const row = list?.[0];
			if (!row || !this.canAdmit(row, counts)) continue;
			list?.shift();
			if (await this.launch(row)) {
				this.recordAdmission(row, counts);
				progressed = true;
			}
		}
		return progressed;
	}

	async admit(): Promise<void> {
		const { store, limits } = this.deps;
		let counts: ActiveCounts;
		try {
			counts = await store.countActive();
		} catch (err) {
			this.report("admit.count", err);
			return;
		}
		while (counts.global < limits.globalActiveWorkspaces) {
			let queued: WorkspaceRow[];
			try {
				queued = await store.listQueuedHeads();
			} catch (err) {
				this.report("admit.list", err);
				return;
			}
			if (queued.length === 0) return;
			// The store returns only each principal's FIFO head, so a deep backlog
			// cannot hide another principal from the round-robin rotation.
			const byPrincipal = this.groupQueuedByPrincipal(queued);
			const rotation = this.principalRotation(byPrincipal);
			if (!(await this.admitRound(byPrincipal, rotation, counts))) return;
		}
	}

	private async launch(row: WorkspaceRow): Promise<boolean> {
		const { store, driver, secrets } = this.deps;
		const now = this.now();
		const secret = secrets.generate();
		const registrationDigest = secrets.digest(secret);
		const registrationExpiresAt = new Date(now.getTime() + this.timeoutMs(row, "start"));
		const input: ProviderInput = {
			workspace_id: row.id,
			server_url: this.deps.workspaceServerUrl,
			registration_secret: secret,
			template_digest: row.templateDigest,
			template_name: row.templateName,
			template_version: row.templateVersion,
			launch_mode: row.launchMode,
			...(row.sourceDescriptor ? { source: row.sourceDescriptor } : {}),
			...(row.restoredFromCheckpointId && row.originWorkspaceId
				? {
						restore: {
							checkpoint_id: row.restoredFromCheckpointId,
							origin_workspace_id: row.originWorkspaceId,
						},
					}
				: {}),
			...(row.launchInput ? { launch_input: row.launchInput } : {}),
		};
		if (this.deps.warmPool) {
			const hit = await this.deps.warmPool.tryLease(
				row,
				input,
				registrationDigest,
				registrationExpiresAt,
			);
			if (hit) return true;
			if (this.deps.warmPool.missDecision(row) === "wait") return false;
		}
		const claimed = await store.claimWorkspaceAdmission({
			workspaceId: row.id,
			at: now,
			registrationDigest,
			registrationExpiresAt,
			limits: this.deps.limits,
		});
		if (!claimed) return false;
		try {
			const mounts = await this.prepareStorage(claimed);
			if (
				!this.deps.secretResolver &&
				JSON.stringify(claimed.templateSnapshot.spec).includes('"secretRef:')
			) {
				throw new Error("secret.unavailable: no deployment secret resolver configured");
			}
			const runtimeSecrets = this.deps.secretResolver
				? await this.deps.secretResolver.resolve(claimed)
				: [];
			const ref = await driver.create({
				workspace: claimed,
				input,
				mounts,
				secrets: runtimeSecrets,
			});
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
				const failurePatch = await this.captureLaunchFailure(row.id, err, at);
				await store.transition(row.id, {
					from: ["provisioning"],
					to: "failed",
					reason: "launch_failed",
					at,
					patch: {
						launchInput: null,
						registrationDigest: null,
						...failurePatch,
					},
				});
				await this.cleanupWorkspaceStorage(claimed);
				await this.finishRestoreOperation(row, "failed", "restore_failed");
			}
			return false;
		}
	}

	private async cleanupWorkspaceStorage(row: WorkspaceRow): Promise<void> {
		const storageDriver = this.deps.storageDriver;
		if (!storageDriver) return;
		const storage = await this.deps.store.getWorkspaceStorage(row.id);
		if (!storage || ["retained", "deleted"].includes(storage.state)) return;
		try {
			if (Object.keys(storage.providerRef).length > 0) {
				await storageDriver.deleteStorage(storage.providerRef as StorageRef);
			}
			const at = this.now();
			await this.deps.store.updateWorkspaceStorage(
				storage.id,
				{ state: "deleted", deletedAt: at },
				at,
			);
		} catch (error) {
			await this.deps.store.updateWorkspaceStorage(
				storage.id,
				{ lastErrorCode: "storage_cleanup_failed" },
				this.now(),
			);
			this.report(`storage.cleanup.${row.id}`, error);
		}
	}

	private async prepareStorage(row: WorkspaceRow): Promise<RuntimeMountRef[]> {
		const mounts = row.templateSnapshot.spec.persistence.mounts;
		if (mounts.length === 0) return [];
		const storageDriver = this.deps.storageDriver;
		if (!storageDriver) {
			throw new Error("workspace.persistence_not_enabled: no storage driver configured");
		}
		const { store } = this.deps;
		let stored = await store.getWorkspaceStorage(row.id);
		if (!stored) {
			const now = this.now();
			stored = await store.insertWorkspaceStorage({
				id: randomUUID(),
				workspaceId: row.id,
				principalId: row.principalId,
				providerKind: storageDriver.kind,
				providerRef: {},
				state: "allocating",
				mountManifest: mounts,
				logicalBytes: null,
				fileCount: null,
				retainedUntil: null,
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
				lastErrorCode: null,
			});
		}
		let ref: StorageRef;
		if (Object.keys(stored.providerRef).length === 0) {
			const allocated = await storageDriver.allocate({
				storageId: stored.id,
				workspaceId: row.id,
				mounts,
				uid: row.templateSnapshot.spec.security.uid,
				gid: row.templateSnapshot.spec.security.gid,
			});
			ref = allocated.ref;
			const state = row.restoredFromCheckpointId ? "restoring" : "ready";
			await store.updateWorkspaceStorage(
				stored.id,
				{ providerRef: allocated.ref, providerKind: storageDriver.kind, state },
				this.now(),
			);
			stored = { ...stored, providerRef: allocated.ref, state };
		} else {
			ref = stored.providerRef as StorageRef;
		}
		if (row.restoredFromCheckpointId && stored.state !== "ready") {
			const checkpoint = await store.getCheckpoint(row.restoredFromCheckpointId);
			if (checkpoint?.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
				throw new Error("checkpoint.not_ready");
			}
			await storageDriver.cloneCheckpoint(
				checkpoint.providerRef as StorageRef,
				ref,
				checkpoint.manifest,
			);
			await store.updateWorkspaceStorage(stored.id, { state: "ready" }, this.now());
		}
		if (row.restoredFromCheckpointId) {
			await this.finishRestoreOperation(row, "succeeded", null);
		}
		return await storageDriver.runtimeMounts(ref, mounts);
	}

	private async finishRestoreOperation(
		row: WorkspaceRow,
		state: "succeeded" | "failed",
		reasonCode: string | null,
	): Promise<void> {
		const operation = (await this.deps.store.listIncompleteOperations()).find(
			(candidate) => candidate.kind === "restore" && candidate.resultWorkspaceId === row.id,
		);
		if (!operation) return;
		const at = this.now();
		await this.deps.store.updateOperation(
			operation.id,
			{ state, reasonCode, completedAt: at, attemptCount: operation.attemptCount + 1 },
			at,
		);
	}
}
