import { randomUUID } from "node:crypto";
import {
	ApiError,
	canonicalJson,
	digestOf,
	isAgentApiNative,
	type PreserveRequest,
	parseDurationMs,
	type ReasonCode,
	type ResolvedSource,
	type RestoreRequest,
} from "@pstdio/pocketcoder-contracts";
import type {
	PrincipalRow,
	Scheduler,
	StorageRef,
	Store,
	WorkspaceCheckpointRow,
	WorkspaceDriver,
	WorkspaceOperationRow,
	WorkspaceRow,
	WorkspaceStorageDriver,
	WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "./hub";
import { templateAuthorized, type WorkspaceService } from "./service";

export interface PersistenceServiceDeps {
	store: Store;
	scheduler: Scheduler;
	driver: WorkspaceDriver;
	storageDriver?: WorkspaceStorageDriver;
	hub: Hub;
	workspaces: WorkspaceService;
	now?: () => Date;
	log?: (message: string) => void;
	limits?: PersistenceLimits;
}

export interface PersistenceLimits {
	maxRetainedBytes: number;
	maxRetainedBytesPerPrincipal: number;
	maxCheckpointsPerPrincipal: number;
	maxCheckpointFiles: number;
	maxConcurrentOperations: number;
}

export const DEFAULT_PERSISTENCE_LIMITS: PersistenceLimits = {
	maxRetainedBytes: 500 * 1024 ** 3,
	maxRetainedBytesPerPrincipal: 100 * 1024 ** 3,
	maxCheckpointsPerPrincipal: 100,
	maxCheckpointFiles: 1_000_000,
	maxConcurrentOperations: 4,
};

type SnapshotResult = Awaited<ReturnType<WorkspaceStorageDriver["snapshot"]>>;

export function toCheckpointResource(row: WorkspaceCheckpointRow) {
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		state: row.state,
		reason_code: row.reasonCode,
		template: {
			name: row.templateSnapshot.name,
			version: row.templateSnapshot.version,
			digest: row.templateDigest,
		},
		manifest_digest: row.manifestDigest,
		logical_bytes: row.logicalBytes,
		stored_bytes: row.storedBytes,
		file_count: row.fileCount,
		mounts: row.templateSnapshot.spec.persistence.mounts.map((mount) => mount.name),
		conversation_restore: row.conversationRestore,
		label: row.label,
		created_at: row.createdAt.toISOString(),
		ready_at: row.readyAt?.toISOString() ?? null,
		expires_at: row.expiresAt?.toISOString() ?? null,
	};
}

export function toOperationResource(row: WorkspaceOperationRow) {
	return {
		id: row.id,
		kind: row.kind,
		state: row.state,
		workspace_id: row.workspaceId,
		checkpoint_id: row.checkpointId,
		result_workspace_id: row.resultWorkspaceId,
		reason_code: row.reasonCode,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		completed_at: row.completedAt?.toISOString() ?? null,
	};
}

export class PersistenceService {
	constructor(private readonly deps: PersistenceServiceDeps) {}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private storageDriver(): WorkspaceStorageDriver {
		if (!this.deps.storageDriver) {
			throw new ApiError(
				"workspace.persistence_not_enabled",
				"Persistent storage is not configured on this deployment.",
			);
		}
		return this.deps.storageDriver;
	}

	private limits(): PersistenceLimits {
		return this.deps.limits ?? DEFAULT_PERSISTENCE_LIMITS;
	}

	async getCheckpointOwned(principal: PrincipalRow, id: string): Promise<WorkspaceCheckpointRow> {
		const row = await this.deps.store.getCheckpoint(id);
		if (!row || row.principalId !== principal.id || row.state === "deleted") {
			throw new ApiError("checkpoint.not_found", "Unknown checkpoint.");
		}
		return row;
	}

	async preserve(
		principal: PrincipalRow,
		workspaceId: string,
		body: PreserveRequest,
		idempotencyKey: string,
		transitionReason: ReasonCode = "preserve_requested",
	): Promise<{
		workspaceId: string;
		checkpoint: WorkspaceCheckpointRow;
		operation: WorkspaceOperationRow;
	}> {
		const workspace = await this.deps.workspaces.getOwned(principal, workspaceId);
		if (workspace.templateSnapshot.spec.persistence.mounts.length === 0) {
			throw new ApiError(
				"workspace.persistence_not_enabled",
				"This template does not declare persistent mounts.",
			);
		}
		if (
			body.retention &&
			!principal.scopes.includes("admin") &&
			parseDurationMs(body.retention) >
				parseDurationMs(workspace.templateSnapshot.spec.persistence.checkpoint.retention)
		) {
			throw new ApiError(
				"validation.invalid",
				"retention may not exceed the template checkpoint policy",
			);
		}
		this.storageDriver();
		const requestDigest = digestOf({ workspace_id: workspaceId, ...body });
		const checkpointId = randomUUID();
		const operationId = randomUUID();
		const now = this.now();
		const operationResult = await this.deps.store.insertOperation({
			id: operationId,
			principalId: principal.id,
			kind: "preserve",
			state: "pending",
			idempotencyKey,
			requestDigest,
			workspaceId,
			checkpointId: null,
			resultWorkspaceId: null,
			reasonCode: null,
			attemptCount: 0,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});
		if (operationResult.conflict) {
			throw new ApiError(
				"idempotency.conflict",
				"This Idempotency-Key was already used with a different preserve request.",
			);
		}
		if (!operationResult.created) {
			const existing = operationResult.operation.checkpointId
				? await this.deps.store.getCheckpoint(operationResult.operation.checkpointId)
				: null;
			if (!existing) throw new ApiError("checkpoint.not_found", "Checkpoint metadata is missing.");
			return {
				workspaceId,
				checkpoint: existing,
				operation: operationResult.operation,
			};
		}
		try {
			await this.assertPreserveAdmission(
				principal.id,
				workspace.templateSnapshot.spec.persistence.mounts.reduce(
					(sum, mount) => sum + mount.maxBytes,
					0,
				),
			);
		} catch (error) {
			await this.failOperation(operationId, "checkpoint_quota_exceeded");
			throw error;
		}

		const storage = await this.deps.store.getWorkspaceStorage(workspace.id);
		if (storage?.state !== "ready") {
			await this.failOperation(operationId, "checkpoint_storage_lost");
			throw new ApiError(
				"workspace.persistence_not_enabled",
				"Workspace persistent storage is not ready.",
			);
		}
		const retention =
			body.retention ?? workspace.templateSnapshot.spec.persistence.checkpoint.retention;
		const expiresAt = new Date(now.getTime() + parseDurationMs(retention));
		const checkpoint = await this.deps.store.insertCheckpoint({
			id: checkpointId,
			workspaceId: workspace.id,
			principalId: workspace.principalId,
			storageId: storage.id,
			parentCheckpointId: workspace.latestCheckpointId,
			state: "creating",
			reasonCode: null,
			providerKind: this.storageDriver().kind,
			providerRef: null,
			templateSnapshot: workspace.templateSnapshot,
			templateDigest: workspace.templateDigest,
			sourceProvenance: workspace.resolvedSource,
			manifest: null,
			manifestDigest: null,
			logicalBytes: null,
			storedBytes: null,
			fileCount: null,
			conversationRestore: workspace.persistenceCapability,
			label: body.label ?? null,
			createdAt: now,
			updatedAt: now,
			readyAt: null,
			expiresAt,
			deletedAt: null,
		});
		await this.deps.store.updateOperation(operationId, { checkpointId: checkpoint.id }, now);
		await this.emitCheckpointEvent("checkpoint.creating", checkpoint);
		const preserving = await this.deps.store.transition(workspace.id, {
			from: ["connected", "ready"],
			to: "preserving",
			reason: transitionReason,
			at: now,
		});
		if (!preserving) {
			await this.deps.store.updateCheckpoint(
				checkpoint.id,
				{ state: "failed", reasonCode: "operation_conflict" },
				this.now(),
			);
			await this.failOperation(operationId, "operation_conflict");
			throw new ApiError("operation.conflict", "Another workspace lifecycle operation won.");
		}
		void this.runPreserve(preserving.id, checkpoint.id, operationId).catch((error) => {
			this.deps.log?.(`preserve ${operationId}: ${String(error)}`);
		});
		return {
			workspaceId,
			checkpoint,
			operation:
				(await this.deps.store.getOperation(operationResult.operation.id)) ??
				operationResult.operation,
		};
	}

	async preserveByPolicy(
		workspace: { id: string; principalId: string },
		trigger: "idle" | "deadline" | "clean_exit" | "failure",
	): Promise<boolean> {
		const principal = (await this.deps.store.listPrincipals()).find(
			(candidate) => candidate.id === workspace.principalId,
		);
		if (!principal || principal.disabledAt) return false;
		await this.preserve(
			principal,
			workspace.id,
			{ label: `policy:${trigger}` },
			`policy:${trigger}:${workspace.id}`,
			"preserved_by_policy",
		);
		return true;
	}

	async storageInventory(): Promise<{
		backend: string;
		storage_count: number;
		checkpoint_count: number;
		unknown_storage: string[];
		unknown_checkpoints: string[];
	}> {
		const driver = this.storageDriver();
		const [storage, checkpoints] = await Promise.all([
			driver.listStorage(),
			driver.listCheckpoints(),
		]);
		const unknownStorage: string[] = [];
		for (const item of storage) {
			if (!(await this.deps.store.getStorage(item.storageId))) {
				unknownStorage.push(item.storageId);
			}
		}
		const unknownCheckpoints: string[] = [];
		for (const item of checkpoints) {
			if (!(await this.deps.store.getCheckpoint(item.checkpointId))) {
				unknownCheckpoints.push(item.checkpointId);
			}
		}
		return {
			backend: driver.kind,
			storage_count: storage.length,
			checkpoint_count: checkpoints.length,
			unknown_storage: unknownStorage.sort(),
			unknown_checkpoints: unknownCheckpoints.sort(),
		};
	}

	async pruneExpired(): Promise<{ deleted: number; skipped: number; transcriptsDeleted: number }> {
		const now = this.now();
		const transcriptsDeleted = await this.deps.store.pruneExpiredConversations(now);
		let deleted = 0;
		let skipped = 0;
		for (const principal of await this.deps.store.listPrincipals()) {
			const checkpoints = await this.deps.store.listCheckpoints(principal.id, {
				state: "ready",
			});
			for (const checkpoint of checkpoints) {
				if (!checkpoint.expiresAt || checkpoint.expiresAt > now) continue;
				try {
					const operation = await this.delete(
						principal,
						checkpoint.id,
						`retention:${checkpoint.id}`,
					);
					if (operation.state === "succeeded") deleted += 1;
					else skipped += 1;
				} catch (error) {
					skipped += 1;
					this.deps.log?.(
						`retention ${checkpoint.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
		return { deleted, skipped, transcriptsDeleted };
	}

	private async stopForSnapshot(workspace: WorkspaceRow, operationId: string): Promise<boolean> {
		const spec = workspace.templateSnapshot.spec;
		const native = isAgentApiNative(spec);
		const hook = native ? undefined : spec.checkpointHook;
		const deadlineMs = native
			? parseDurationMs(spec.timeouts.terminateGrace)
			: (hook?.timeoutSeconds ?? 0) * 1000;
		const quiesced =
			native || hook
				? await this.deps.hub.prepareCheckpoint(workspace.id, operationId, deadlineMs)
				: false;
		if (!workspace.providerRef) return quiesced;
		await this.deps.driver.stop(
			{
				kind: workspace.providerKind ?? "",
				id: "",
				...workspace.providerRef,
			},
			Math.max(
				1,
				Math.ceil(parseDurationMs(workspace.templateSnapshot.spec.timeouts.terminateGrace) / 1000),
			),
		);
		return quiesced;
	}

	private async createSnapshot(
		workspace: WorkspaceRow,
		checkpoint: WorkspaceCheckpointRow,
		storage: WorkspaceStorageRow,
	): Promise<SnapshotResult> {
		const storageDriver = this.storageDriver();
		await this.deps.store.updateWorkspaceStorage(storage.id, { state: "snapshotting" }, this.now());
		const result = await storageDriver.snapshot(
			storage.providerRef as StorageRef,
			checkpoint.id,
			workspace.templateDigest,
			storage.mountManifest,
		);
		await storageDriver.verifyCheckpoint(result.ref, result.manifest);
		await this.assertMeasuredCheckpoint(
			workspace.principalId,
			result.manifest.logical_bytes,
			result.manifest.file_count,
		);
		return result;
	}

	private async completePreserve(
		workspace: WorkspaceRow,
		checkpoint: WorkspaceCheckpointRow,
		storage: WorkspaceStorageRow,
		operationId: string,
		result: SnapshotResult,
		quiesced: boolean,
	): Promise<void> {
		const { store, driver, hub } = this.deps;
		const readyAt = this.now();
		const conversationRestore = quiesced ? workspace.persistenceCapability : "filesystem_only";
		await store.updateCheckpoint(
			checkpoint.id,
			{
				state: "ready",
				providerKind: this.storageDriver().kind,
				providerRef: result.ref,
				manifest: result.manifest,
				manifestDigest: result.manifestDigest,
				logicalBytes: result.manifest.logical_bytes,
				storedBytes: result.storedBytes,
				fileCount: result.manifest.file_count,
				conversationRestore,
				readyAt,
			},
			readyAt,
		);
		const readyCheckpoint = await store.getCheckpoint(checkpoint.id);
		if (readyCheckpoint) await this.emitCheckpointEvent("checkpoint.ready", readyCheckpoint);
		await store.updateWorkspaceStorage(
			storage.id,
			{
				state: "retained",
				logicalBytes: result.manifest.logical_bytes,
				fileCount: result.manifest.file_count,
				retainedUntil: checkpoint.expiresAt,
			},
			readyAt,
		);
		await store.updateWorkspace(
			workspace.id,
			{ latestCheckpointId: checkpoint.id, persistenceCapability: conversationRestore },
			readyAt,
		);
		if (workspace.providerRef) {
			await driver.remove({
				kind: workspace.providerKind ?? "",
				id: "",
				...workspace.providerRef,
			});
		}
		hub.close(workspace.id);
		await store.transition(workspace.id, {
			from: ["preserving"],
			to: "preserved",
			reason: "checkpoint_created",
			at: readyAt,
			patch: { latestCheckpointId: checkpoint.id },
		});
		await store.updateOperation(operationId, { state: "succeeded", completedAt: readyAt }, readyAt);
	}

	private async handlePreserveFailure(
		error: unknown,
		workspace: WorkspaceRow,
		checkpoint: WorkspaceCheckpointRow,
		storage: WorkspaceStorageRow,
		operationId: string,
		stopped: boolean,
	): Promise<void> {
		const { store, driver, hub } = this.deps;
		const at = this.now();
		const quota = error instanceof Error && error.message.includes("checkpoint.quota_exceeded");
		const reason = quota ? "checkpoint_quota_exceeded" : "checkpoint_failed";
		await store.updateCheckpoint(checkpoint.id, { state: "failed", reasonCode: reason }, at);
		const failedCheckpoint = await store.getCheckpoint(checkpoint.id);
		if (failedCheckpoint) {
			await this.emitCheckpointEvent("checkpoint.failed", failedCheckpoint);
		}
		await store.updateWorkspaceStorage(
			storage.id,
			{
				state: stopped ? "retained" : storage.state,
				lastErrorCode: reason,
			},
			at,
		);
		if (stopped && workspace.providerRef) {
			await driver
				.remove({
					kind: workspace.providerKind ?? "",
					id: "",
					...workspace.providerRef,
				})
				.catch((removeError) => {
					this.deps.log?.(`preserve cleanup ${workspace.id}: ${String(removeError)}`);
				});
			hub.close(workspace.id);
		}
		await store.transition(workspace.id, {
			from: ["preserving"],
			to: "failed",
			reason,
			at,
		});
		await this.failOperation(operationId, reason);
	}

	private async runPreserve(
		workspaceId: string,
		checkpointId: string,
		operationId: string,
	): Promise<void> {
		const { store } = this.deps;
		await store.updateOperation(operationId, { state: "running", attemptCount: 1 }, this.now());
		const workspace = await store.getWorkspace(workspaceId);
		const checkpoint = await store.getCheckpoint(checkpointId);
		const storage = await store.getWorkspaceStorage(workspaceId);
		if (!workspace || !checkpoint || !storage) {
			await this.failOperation(operationId, "checkpoint_storage_lost");
			return;
		}
		let stopped = false;
		try {
			const quiesced = await this.stopForSnapshot(workspace, operationId);
			stopped = workspace.providerRef !== null;
			const result = await this.createSnapshot(workspace, checkpoint, storage);
			await this.completePreserve(workspace, checkpoint, storage, operationId, result, quiesced);
		} catch (error) {
			await this.handlePreserveFailure(error, workspace, checkpoint, storage, operationId, stopped);
			throw error;
		}
	}

	async restore(
		principal: PrincipalRow,
		checkpointId: string,
		body: RestoreRequest,
		idempotencyKey: string,
	): Promise<{ workspaceId: string; operation: WorkspaceOperationRow }> {
		const checkpoint = await this.getCheckpointOwned(principal, checkpointId);
		if (checkpoint.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
			throw new ApiError("checkpoint.not_ready", "Checkpoint is not ready for restore.");
		}
		if (!templateAuthorized(principal, checkpoint.templateSnapshot.name)) {
			throw new ApiError(
				"restore.template_not_authorized",
				"Principal is no longer authorized for this checkpoint template.",
			);
		}
		this.storageDriver();
		const now = this.now();
		const requestDigest = digestOf({ checkpoint_id: checkpointId, ...body });
		await this.assertOperationCapacity(principal.id, "restore", idempotencyKey);
		const resultWorkspaceId = randomUUID();
		const operationResult = await this.deps.store.insertOperation({
			id: randomUUID(),
			principalId: principal.id,
			kind: "restore",
			state: "pending",
			idempotencyKey,
			requestDigest,
			workspaceId: checkpoint.workspaceId,
			checkpointId,
			resultWorkspaceId: null,
			reasonCode: null,
			attemptCount: 0,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});
		if (operationResult.conflict) {
			throw new ApiError(
				"idempotency.conflict",
				"This Idempotency-Key was already used with a different restore request.",
			);
		}
		if (!operationResult.created) {
			const existingWorkspace = operationResult.operation.resultWorkspaceId
				? await this.deps.store.getWorkspace(operationResult.operation.resultWorkspaceId)
				: null;
			if (existingWorkspace) {
				return {
					workspaceId: existingWorkspace.id,
					operation: operationResult.operation,
				};
			}
			if (
				!operationResult.operation.resultWorkspaceId ||
				operationResult.operation.state === "failed" ||
				operationResult.operation.state === "succeeded"
			) {
				throw new ApiError("restore.incompatible", "Restore metadata is incomplete.");
			}
		}
		const restoreWorkspaceId = operationResult.operation.resultWorkspaceId ?? resultWorkspaceId;
		const source = checkpoint.sourceProvenance
			? {
					kind: "git" as const,
					repository: checkpoint.sourceProvenance.repository,
					revision: checkpoint.sourceProvenance.requested_revision,
				}
			: null;
		const template = await this.deps.store.getTemplate(
			checkpoint.templateSnapshot.name,
			checkpoint.templateSnapshot.version,
		);
		if (!template) {
			await this.failOperation(operationResult.operation.id, "image_unavailable");
			throw new ApiError(
				"restore.image_unavailable",
				"The exact checkpoint template snapshot is unavailable.",
			);
		}
		const inserted = await this.deps.store.insertWorkspace({
			id: restoreWorkspaceId,
			principalId: principal.id,
			externalId: body.external_id,
			idempotencyKey: `restore:${operationResult.operation.id}`,
			requestDigest,
			templateId: template.id,
			templateSnapshot: checkpoint.templateSnapshot,
			launchInput: null,
			metadata: body.metadata ?? {},
			deadlineAt: new Date(
				now.getTime() + parseDurationMs(checkpoint.templateSnapshot.spec.timeouts.maxAge),
			),
			createdAt: now,
			originWorkspaceId: checkpoint.workspaceId,
			restoredFromCheckpointId: checkpoint.id,
			sourceDescriptor: source,
			resolvedSource: checkpoint.sourceProvenance,
			persistenceCapability: checkpoint.conversationRestore,
			launchMode: "restore",
		});
		if (inserted.conflict) {
			await this.failOperation(operationResult.operation.id, "operation_conflict");
			throw new ApiError("idempotency.conflict", "The requested external_id is already active.");
		}
		await this.deps.store.updateOperation(
			operationResult.operation.id,
			{ resultWorkspaceId: inserted.workspace.id },
			now,
		);
		await this.deps.store.appendEvent(
			checkpoint.workspaceId,
			"workspace.restore_queued",
			{
				id: randomUUID(),
				type: "workspace.restore_queued",
				occurred_at: now.toISOString(),
				origin_workspace_id: checkpoint.workspaceId,
				checkpoint_id: checkpoint.id,
				result_workspace_id: inserted.workspace.id,
			},
			now,
		);
		void this.deps.scheduler.tick().catch(() => {});
		return {
			workspaceId: inserted.workspace.id,
			operation:
				(await this.deps.store.getOperation(operationResult.operation.id)) ??
				operationResult.operation,
		};
	}

	async verify(
		principal: PrincipalRow,
		checkpointId: string,
		idempotencyKey: string,
	): Promise<WorkspaceOperationRow> {
		const checkpoint = await this.getCheckpointOwned(principal, checkpointId);
		if (checkpoint.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
			throw new ApiError("checkpoint.not_ready", "Checkpoint is not ready.");
		}
		const now = this.now();
		await this.assertOperationCapacity(principal.id, "verify", idempotencyKey);
		const inserted = await this.deps.store.insertOperation({
			id: randomUUID(),
			principalId: principal.id,
			kind: "verify",
			state: "running",
			idempotencyKey,
			requestDigest: digestOf({ checkpoint_id: checkpointId }),
			workspaceId: checkpoint.workspaceId,
			checkpointId,
			resultWorkspaceId: null,
			reasonCode: null,
			attemptCount: 1,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});
		if (inserted.conflict) {
			throw new ApiError("idempotency.conflict", "Changed verify request.");
		}
		if (!inserted.created) return inserted.operation;
		try {
			await this.storageDriver().verifyCheckpoint(
				checkpoint.providerRef as StorageRef,
				checkpoint.manifest,
			);
			const done = this.now();
			await this.deps.store.updateOperation(
				inserted.operation.id,
				{ state: "succeeded", completedAt: done },
				done,
			);
		} catch {
			await this.deps.store.updateCheckpoint(
				checkpoint.id,
				{ state: "failed", reasonCode: "checkpoint_corrupt" },
				this.now(),
			);
			await this.failOperation(inserted.operation.id, "checkpoint_corrupt");
			throw new ApiError("checkpoint.corrupt", "Checkpoint integrity verification failed.");
		}
		return (await this.deps.store.getOperation(inserted.operation.id)) ?? inserted.operation;
	}

	async delete(
		principal: PrincipalRow,
		checkpointId: string,
		idempotencyKey: string,
	): Promise<WorkspaceOperationRow> {
		const checkpoint = await this.getCheckpointOwned(principal, checkpointId);
		const activeRestore = (await this.deps.store.listIncompleteOperations()).some(
			(operation) => operation.kind === "restore" && operation.checkpointId === checkpoint.id,
		);
		if (activeRestore) {
			throw new ApiError("checkpoint.in_use", "Checkpoint has an active restore.");
		}
		const now = this.now();
		await this.assertOperationCapacity(principal.id, "delete", idempotencyKey);
		const inserted = await this.deps.store.insertOperation({
			id: randomUUID(),
			principalId: principal.id,
			kind: "delete",
			state: "running",
			idempotencyKey,
			requestDigest: digestOf({ checkpoint_id: checkpointId }),
			workspaceId: checkpoint.workspaceId,
			checkpointId,
			resultWorkspaceId: null,
			reasonCode: null,
			attemptCount: 1,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});
		if (inserted.conflict) throw new ApiError("idempotency.conflict", "Changed delete request.");
		if (!inserted.created) return inserted.operation;
		await this.deps.store.updateCheckpoint(checkpoint.id, { state: "deleting" }, now);
		const deleting = await this.deps.store.getCheckpoint(checkpoint.id);
		if (deleting) await this.emitCheckpointEvent("checkpoint.deleting", deleting);
		try {
			if (checkpoint.providerRef) {
				await this.storageDriver().deleteCheckpoint(checkpoint.providerRef as StorageRef);
			}
			const done = this.now();
			await this.deps.store.updateCheckpoint(
				checkpoint.id,
				{ state: "deleted", deletedAt: done },
				done,
			);
			const deleted = await this.deps.store.getCheckpoint(checkpoint.id);
			if (deleted) await this.emitCheckpointEvent("checkpoint.deleted", deleted);
			await this.deps.store.updateOperation(
				inserted.operation.id,
				{ state: "succeeded", completedAt: done },
				done,
			);
		} catch {
			await this.failOperation(inserted.operation.id, "checkpoint_failed");
		}
		return (await this.deps.store.getOperation(inserted.operation.id)) ?? inserted.operation;
	}

	async sourceResolved(workspaceId: string, source: ResolvedSource): Promise<void> {
		const workspace = await this.deps.store.getWorkspace(workspaceId);
		if (
			!workspace?.sourceDescriptor ||
			workspace.sourceDescriptor.repository !== source.repository ||
			workspace.sourceDescriptor.revision !== source.requested_revision
		) {
			throw new Error("source resolution does not match the requested descriptor");
		}
		if (
			workspace.resolvedSource &&
			canonicalJson(workspace.resolvedSource) !== canonicalJson(source)
		) {
			throw new Error("resolved source is immutable");
		}
		await this.deps.store.updateWorkspace(workspaceId, { resolvedSource: source }, this.now());
	}

	async publishOutput(workspaceId: string, name: string, value: unknown): Promise<void> {
		const workspace = await this.deps.store.getWorkspace(workspaceId);
		if (!workspace) throw new Error("workspace not found");
		const declaration = workspace.templateSnapshot.spec.outputs[name];
		if (!declaration) throw new Error("output is not declared by the template");
		if (Buffer.byteLength(canonicalJson(value)) > 16_384) {
			throw new Error("output exceeds the maximum encoded size");
		}
		if (
			declaration.type === "gitSha" &&
			(typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value))
		) {
			throw new Error("output is not a valid git SHA");
		}
		if (declaration.type === "string") {
			if (typeof value !== "string" || value.length > declaration.maxLength) {
				throw new Error("output is not a bounded string");
			}
		}
		if (declaration.type === "httpsUrl") {
			if (typeof value !== "string" || value.length > declaration.maxLength) {
				throw new Error("output is not a bounded HTTPS URL");
			}
			const url = new URL(value);
			if (url.protocol !== "https:" || url.username || url.password) {
				throw new Error("output is not a safe HTTPS URL");
			}
		}
		await this.deps.store.appendOutput({
			workspaceId,
			seq: 0,
			name,
			value,
			occurredAt: this.now(),
		});
		const at = this.now();
		await this.deps.store.appendEvent(
			workspaceId,
			"workspace.output_published",
			{
				id: randomUUID(),
				type: "workspace.output_published",
				occurred_at: at.toISOString(),
				workspace_id: workspaceId,
				name,
				value,
			},
			at,
		);
	}

	private async failOperation(id: string, reasonCode: string): Promise<void> {
		const at = this.now();
		await this.deps.store.updateOperation(id, { state: "failed", reasonCode, completedAt: at }, at);
	}

	private async assertPreserveAdmission(principalId: string, declaredBytes: number): Promise<void> {
		const [global, principal, incomplete] = await Promise.all([
			this.deps.store.checkpointUsage(null),
			this.deps.store.checkpointUsage(principalId),
			this.deps.store.countIncompleteOperations(),
		]);
		const limits = this.limits();
		if (
			incomplete > limits.maxConcurrentOperations ||
			principal.count >= limits.maxCheckpointsPerPrincipal ||
			global.logicalBytes + declaredBytes > limits.maxRetainedBytes ||
			principal.logicalBytes + declaredBytes > limits.maxRetainedBytesPerPrincipal
		) {
			throw new ApiError(
				"checkpoint.quota_exceeded",
				"Checkpoint admission exceeds deployment or principal storage limits.",
			);
		}
	}

	private async assertMeasuredCheckpoint(
		principalId: string,
		logicalBytes: number,
		fileCount: number,
	): Promise<void> {
		const [global, principal] = await Promise.all([
			this.deps.store.checkpointUsage(null),
			this.deps.store.checkpointUsage(principalId),
		]);
		const limits = this.limits();
		if (
			fileCount > limits.maxCheckpointFiles ||
			global.logicalBytes + logicalBytes > limits.maxRetainedBytes ||
			principal.logicalBytes + logicalBytes > limits.maxRetainedBytesPerPrincipal
		) {
			throw new Error("checkpoint.quota_exceeded");
		}
	}

	private async assertOperationCapacity(
		principalId: string,
		kind: "restore" | "verify" | "delete",
		idempotencyKey: string,
	): Promise<void> {
		const existing = await this.deps.store.getOperationByIdempotency(
			principalId,
			kind,
			idempotencyKey,
		);
		if (existing) return;
		if (
			(await this.deps.store.countIncompleteOperations()) >= this.limits().maxConcurrentOperations
		) {
			throw new ApiError(
				"storage.capacity_exhausted",
				"Too many checkpoint operations are already running.",
			);
		}
	}

	private async emitCheckpointEvent(
		type:
			| "checkpoint.creating"
			| "checkpoint.ready"
			| "checkpoint.failed"
			| "checkpoint.deleting"
			| "checkpoint.deleted",
		row: WorkspaceCheckpointRow,
	): Promise<void> {
		const at = this.now();
		await this.deps.store.appendEvent(
			row.workspaceId,
			type,
			{
				id: randomUUID(),
				type,
				occurred_at: at.toISOString(),
				checkpoint: {
					id: row.id,
					workspace_id: row.workspaceId,
					state: row.state,
					reason_code: row.reasonCode,
					logical_bytes: row.logicalBytes,
					file_count: row.fileCount,
					expires_at: row.expiresAt?.toISOString() ?? null,
				},
			},
			at,
		);
	}
}
