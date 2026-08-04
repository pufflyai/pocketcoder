import { randomUUID } from "node:crypto";
import type { ProviderInput } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef, StorageRef } from "./driver";
import { SchedulerSweep } from "./scheduler-sweep";
import type { ActiveCounts, WorkspaceRow } from "./types";

export class SchedulerAdmission extends SchedulerSweep {
	protected groupQueuedByPrincipal(queued: WorkspaceRow[]): Map<string, WorkspaceRow[]> {
		const byPrincipal = new Map<string, WorkspaceRow[]>();
		for (const row of queued) {
			const list = byPrincipal.get(row.principalId) ?? [];
			list.push(row);
			byPrincipal.set(row.principalId, list);
		}
		return byPrincipal;
	}

	protected principalRotation(byPrincipal: Map<string, WorkspaceRow[]>): string[] {
		const principals = [...byPrincipal.keys()];
		const startIndex = this.lastAdmittedPrincipal
			? (principals.indexOf(this.lastAdmittedPrincipal) + 1) % principals.length
			: 0;
		return [...principals.slice(startIndex), ...principals.slice(0, startIndex)];
	}

	protected canAdmit(row: WorkspaceRow, counts: ActiveCounts): boolean {
		const { limits } = this.deps;
		const principalActive = counts.byPrincipal[row.principalId] ?? 0;
		if (principalActive >= limits.perPrincipalActiveWorkspaces) return false;
		const templateLimit =
			limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
		return (counts.byTemplate[row.templateName] ?? 0) < templateLimit;
	}

	protected recordAdmission(row: WorkspaceRow, counts: ActiveCounts): void {
		counts.global += 1;
		counts.byPrincipal[row.principalId] = (counts.byPrincipal[row.principalId] ?? 0) + 1;
		counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + 1;
		this.lastAdmittedPrincipal = row.principalId;
	}

	protected async admitRound(
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
			this.deps.metrics?.increment("admission.total", { result: "attempted" });
			if (await this.launch(row)) {
				this.recordAdmission(row, counts);
				this.deps.metrics?.increment("admission.total", { result: "accepted" });
				this.deps.metrics?.observe(
					"workspace.queue_delay_ms",
					Math.max(0, this.now().getTime() - row.createdAt.getTime()),
					{ template: row.templateName },
				);
				progressed = true;
			} else {
				this.deps.metrics?.increment("admission.total", { result: "deferred" });
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

	protected async launch(row: WorkspaceRow): Promise<boolean> {
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

	protected async prepareStorage(row: WorkspaceRow): Promise<RuntimeMountRef[]> {
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
}
