import { randomUUID } from "node:crypto";
import {
	type CheckpointState,
	canTransition,
	isTerminal,
	type OperationKind,
	parseDurationMs,
	type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import {
	type ActiveCounts,
	buildEventEnvelope,
	type ConversationMessageRow,
	type ConversationStateRow,
	type LogRow,
	type MachineKeyRow,
	type NetworkEventRow,
	OperationCapacityExceededError,
	type OutboxRow,
	type PrincipalRow,
	type StateHistoryRow,
	type Store,
	type TemplateRow,
	type TemplateStatus,
	type TemplateUpsert,
	type TransitionRequest,
	type UpsertResult,
	type WarmPoolClaim,
	type WarmPoolRuntimePatch,
	type WarmPoolRuntimeRow,
	type WorkspaceAdmissionClaim,
	type WorkspaceCheckpointPatch,
	type WorkspaceCheckpointRow,
	type WorkspaceInsert,
	type WorkspaceInsertResult,
	type WorkspaceListFilter,
	type WorkspaceOperationPatch,
	type WorkspaceOperationRow,
	type WorkspaceOutputRow,
	type WorkspacePatch,
	type WorkspaceRow,
	type WorkspaceStoragePatch,
	type WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-contracts";

// In-memory adapter for tests and single-process development. PostgreSQL is
// the durable implementation; both satisfy the same behavioral contract.

const ACTIVE_STATES: readonly WorkspaceState[] = [
	"provisioning",
	"connected",
	"ready",
	"preserving",
	"terminating",
];
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 100_000;
const CHANGE_PATCH_KEYS = new Set([
	"connectedAt",
	"disconnectedAt",
	"health",
	"agentState",
	"failureLogTail",
	"failureLogTailTruncated",
	"failureLastLogSeq",
	"resolvedSource",
	"persistenceCapability",
	"latestCheckpointId",
	"outputs",
]);

export class MemoryStore implements Store {
	private templates: TemplateRow[] = [];
	private principals: PrincipalRow[] = [];
	private keys: MachineKeyRow[] = [];
	private workspaces = new Map<string, WorkspaceRow>();
	private warmPoolRuntimes = new Map<string, WarmPoolRuntimeRow>();
	private history: StateHistoryRow[] = [];
	private outbox: OutboxRow[] = [];
	private logs = new Map<string, LogRow[]>();
	private networkEvents = new Map<string, NetworkEventRow[]>();
	private logBytes = new Map<string, number>();
	private claimedEvents = new Set<string>();
	private storage = new Map<string, WorkspaceStorageRow>();
	private checkpoints = new Map<string, WorkspaceCheckpointRow>();
	private operations = new Map<string, WorkspaceOperationRow>();
	private outputs = new Map<string, WorkspaceOutputRow[]>();
	private conversations = new Map<string, ConversationMessageRow[]>();
	private conversationBytes = new Map<string, number>();
	private conversationStates = new Map<string, ConversationStateRow>();
	private changeWaiters = new Map<string, Set<() => void>>();
	private coordinatorActive = false;

	async init(): Promise<void> {}
	async acquireCoordinatorLease(): Promise<() => Promise<void>> {
		if (this.coordinatorActive) throw new Error("a PocketCoder coordinator is already active");
		this.coordinatorActive = true;
		return async () => {
			this.coordinatorActive = false;
		};
	}
	async close(): Promise<void> {
		this.coordinatorActive = false;
		for (const waiters of this.changeWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.changeWaiters.clear();
	}

	private notifyWorkspaceChange(id: string): void {
		const waiters = this.changeWaiters.get(id);
		if (!waiters) return;
		this.changeWaiters.delete(id);
		for (const resolve of waiters) resolve();
	}

	// --- Templates ---

	async upsertTemplate(input: TemplateUpsert): Promise<UpsertResult> {
		const existing = this.templates.find(
			(t) => t.name === input.name && t.version === input.version,
		);
		if (existing) {
			if (existing.digest !== input.digest) {
				return { row: existing, created: false, conflict: true };
			}
			return { row: existing, created: false, conflict: false };
		}
		const row: TemplateRow = {
			id: randomUUID(),
			name: input.name,
			version: input.version,
			digest: input.digest,
			description: input.description,
			spec: input.spec,
			status: "active",
			createdAt: new Date(),
			retiredAt: null,
		};
		// Only the newest loaded version of a name stays "active"; earlier
		// ones remain selectable by explicit version.
		for (const t of this.templates) {
			if (t.name === input.name && t.status === "active") {
				t.status = "available";
			}
		}
		this.templates.push(row);
		return { row, created: true, conflict: false };
	}

	async listTemplates(names: string[] | null): Promise<TemplateRow[]> {
		return this.templates.filter((t) => !names || names.includes(t.name)).map((t) => ({ ...t }));
	}

	async getTemplate(name: string, version?: string): Promise<TemplateRow | null> {
		if (version) {
			return this.templates.find((t) => t.name === name && t.version === version) ?? null;
		}
		const active = this.templates.filter((t) => t.name === name && t.status === "active");
		return active[active.length - 1] ?? null;
	}

	async setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void> {
		const row = this.templates.find((t) => t.name === name && t.version === version);
		if (row) {
			row.status = status;
			row.retiredAt = status === "retired" ? new Date() : null;
		}
	}

	async insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow> {
		const existing = this.warmPoolRuntimes.get(row.id);
		if (existing) return { ...existing };
		this.warmPoolRuntimes.set(row.id, { ...row });
		return { ...row };
	}

	async getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null> {
		const row = this.warmPoolRuntimes.get(id);
		return row ? { ...row } : null;
	}

	async listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]> {
		return [...this.warmPoolRuntimes.values()].map((row) => ({ ...row }));
	}

	async updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void> {
		const row = this.warmPoolRuntimes.get(id);
		if (!row) return;
		Object.assign(row, patch);
		row.updatedAt = at;
	}

	async claimWarmPoolRuntime(
		claim: WarmPoolClaim,
	): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null> {
		const workspace = this.workspaces.get(claim.workspaceId);
		if (workspace?.state !== "queued") return null;
		const runtime = [...this.warmPoolRuntimes.values()]
			.filter(
				(row) =>
					row.state === "ready" &&
					row.templateDigest === claim.templateDigest &&
					row.driverKind === claim.driverKind &&
					row.eligibilityFingerprint === claim.eligibilityFingerprint,
			)
			.sort((a, b) => (a.readyAt?.getTime() ?? 0) - (b.readyAt?.getTime() ?? 0))[0];
		if (!runtime?.providerRef) return null;
		runtime.state = "leasing";
		runtime.workspaceId = workspace.id;
		runtime.leasedAt = claim.at;
		runtime.updatedAt = claim.at;
		workspace.state = "provisioning";
		workspace.provisioningMode = "warm";
		workspace.providerKind = runtime.driverKind;
		workspace.providerRef = runtime.providerRef;
		workspace.registrationDigest = claim.registrationDigest;
		workspace.registrationExpiresAt = claim.registrationExpiresAt;
		workspace.launchAttempts += 1;
		workspace.changeSeq += 1;
		workspace.updatedAt = claim.at;
		this.appendHistory(workspace, "queued", "provisioning", null, claim.at);
		this.appendWorkspaceEvent(workspace, claim.at);
		this.notifyWorkspaceChange(workspace.id);
		return { runtime: { ...runtime }, workspace: { ...workspace } };
	}

	// --- Principals and keys ---

	async createPrincipal(
		name: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow> {
		if (this.principals.some((p) => p.name === name)) {
			throw new Error(`principal exists: ${name}`);
		}
		const row: PrincipalRow = {
			id: randomUUID(),
			name,
			scopes,
			templateNames,
			disabledAt: null,
			createdAt: new Date(),
		};
		this.principals.push(row);
		return row;
	}

	async getPrincipalByName(name: string): Promise<PrincipalRow | null> {
		return this.principals.find((p) => p.name === name) ?? null;
	}

	async listPrincipals(): Promise<PrincipalRow[]> {
		return this.principals.map((p) => ({ ...p }));
	}

	async updatePrincipal(
		id: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow | null> {
		const row = this.principals.find((principal) => principal.id === id);
		if (!row) return null;
		row.scopes = [...scopes];
		row.templateNames = [...templateNames];
		return { ...row };
	}

	async setPrincipalDisabled(id: string, disabled: boolean): Promise<void> {
		const row = this.principals.find((p) => p.id === id);
		if (row) {
			row.disabledAt = disabled ? new Date() : null;
		}
	}

	async insertMachineKey(row: MachineKeyRow): Promise<void> {
		this.keys.push({ ...row });
	}

	async getMachineKeyWithPrincipal(
		keyId: string,
	): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null> {
		const key = this.keys.find((k) => k.id === keyId);
		if (!key) return null;
		const principal = this.principals.find((p) => p.id === key.principalId);
		if (!principal) return null;
		return { key: { ...key }, principal: { ...principal } };
	}

	async revokeMachineKey(keyId: string, at: Date): Promise<boolean> {
		const key = this.keys.find((k) => k.id === keyId);
		if (!key || key.revokedAt) return false;
		key.revokedAt = at;
		return true;
	}

	async touchMachineKey(keyId: string, at: Date): Promise<void> {
		const key = this.keys.find((k) => k.id === keyId);
		if (key) key.lastUsedAt = at;
	}

	// --- Workspaces ---
	private workspaceInsertConflict(row: WorkspaceInsert): WorkspaceInsertResult | null {
		for (const existing of this.workspaces.values()) {
			if (existing.principalId !== row.principalId) continue;
			if (existing.idempotencyKey === row.idempotencyKey) {
				return existing.requestDigest === row.requestDigest
					? { kind: "replayed", workspace: { ...existing } }
					: { kind: "conflict", conflict: "idempotency", workspace: { ...existing } };
			}
			if (existing.externalId === row.externalId && !isTerminal(existing.state)) {
				return { kind: "conflict", conflict: "external_id", workspace: { ...existing } };
			}
		}
		return null;
	}

	private queueIsFull(maxQueuedWorkspaces: number | undefined): boolean {
		return (
			maxQueuedWorkspaces !== undefined &&
			[...this.workspaces.values()].filter((workspace) => workspace.state === "queued").length >=
				maxQueuedWorkspaces
		);
	}

	async insertWorkspace(
		row: WorkspaceInsert,
		options: { maxQueuedWorkspaces?: number } = {},
	): Promise<WorkspaceInsertResult> {
		const conflict = this.workspaceInsertConflict(row);
		if (conflict) return conflict;
		if (this.queueIsFull(options.maxQueuedWorkspaces)) return { kind: "capacity_exceeded" };
		const snapshot = row.templateSnapshot;
		const workspace: WorkspaceRow = {
			id: row.id,
			principalId: row.principalId,
			externalId: row.externalId,
			idempotencyKey: row.idempotencyKey,
			requestDigest: row.requestDigest,
			templateId: row.templateId,
			templateName: snapshot.name,
			templateVersion: snapshot.version,
			templateDigest: snapshot.digest,
			templateSnapshot: snapshot,
			state: "queued",
			reasonCode: null,
			agentState: "unknown",
			networkState: snapshot.spec.network.mode === "restricted" ? "starting" : "disabled",
			networkEventSeq: 0,
			changeSeq: 1,
			failureLogTail: null,
			failureLogTailTruncated: false,
			failureLastLogSeq: null,
			terminalIntent: null,
			launchInput: row.launchInput,
			providerKind: null,
			providerRef: null,
			provisioningMode: null,
			registrationDigest: null,
			registrationExpiresAt: null,
			reconnectDigest: null,
			connectionEpoch: 0,
			connectedAt: null,
			disconnectedAt: null,
			readyAt: null,
			lastActivityAt: null,
			launchAttempts: 0,
			health: {},
			metadata: row.metadata,
			deadlineAt: row.deadlineAt,
			createdAt: row.createdAt,
			updatedAt: row.createdAt,
			terminalAt: null,
			originWorkspaceId: row.originWorkspaceId ?? null,
			restoredFromCheckpointId: row.restoredFromCheckpointId ?? null,
			sourceDescriptor: row.sourceDescriptor ?? null,
			resolvedSource: row.resolvedSource ?? null,
			persistenceCapability: row.persistenceCapability ?? "filesystem_only",
			latestCheckpointId: row.latestCheckpointId ?? null,
			launchMode: row.launchMode ?? "create",
			outputs: row.outputs ?? {},
		};
		this.workspaces.set(workspace.id, workspace);
		this.appendHistory(workspace, null, "queued", null, row.createdAt);
		this.appendWorkspaceEvent(workspace, row.createdAt);
		return { kind: "created", workspace: { ...workspace } };
	}

	async getWorkspaceByIdempotency(
		principalId: string,
		idempotencyKey: string,
	): Promise<WorkspaceRow | null> {
		const workspace = [...this.workspaces.values()].find(
			(candidate) =>
				candidate.principalId === principalId && candidate.idempotencyKey === idempotencyKey,
		);
		return workspace ? { ...workspace } : null;
	}

	async getWorkspace(id: string): Promise<WorkspaceRow | null> {
		const row = this.workspaces.get(id);
		return row ? { ...row } : null;
	}

	async listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]> {
		let rows = [...this.workspaces.values()].filter((w) => w.principalId === principalId);
		if (filter.externalId) rows = rows.filter((w) => w.externalId === filter.externalId);
		if (filter.state) rows = rows.filter((w) => w.state === filter.state);
		if (filter.template) rows = rows.filter((w) => w.templateName === filter.template);
		if (filter.metadata) {
			rows = rows.filter((w) =>
				Object.entries(filter.metadata ?? {}).every(([key, value]) => w.metadata[key] === value),
			);
		}
		const { createdAfter, createdBefore } = filter;
		if (createdAfter) rows = rows.filter((w) => w.createdAt >= createdAfter);
		if (createdBefore) rows = rows.filter((w) => w.createdAt < createdBefore);
		rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
		if (filter.cursor) {
			const idx = rows.findIndex((w) => w.id === filter.cursor);
			if (idx >= 0) rows = rows.slice(idx + 1);
		}
		return rows.slice(0, filter.limit).map((w) => ({ ...w }));
	}

	async listQueuedHeads(): Promise<WorkspaceRow[]> {
		const queued = [...this.workspaces.values()]
			.filter((w) => w.state === "queued")
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
		const heads = new Map<string, WorkspaceRow>();
		for (const workspace of queued) {
			if (!heads.has(workspace.principalId)) heads.set(workspace.principalId, workspace);
		}
		return [...heads.values()].map((workspace) => ({ ...workspace }));
	}

	async listNonterminal(): Promise<WorkspaceRow[]> {
		return [...this.workspaces.values()].filter((w) => !isTerminal(w.state)).map((w) => ({ ...w }));
	}

	private activeCounts(): ActiveCounts {
		const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
		for (const w of this.workspaces.values()) {
			if (!ACTIVE_STATES.includes(w.state)) continue;
			counts.global += 1;
			counts.byPrincipal[w.principalId] = (counts.byPrincipal[w.principalId] ?? 0) + 1;
			counts.byTemplate[w.templateName] = (counts.byTemplate[w.templateName] ?? 0) + 1;
		}
		return counts;
	}

	async countActive(): Promise<ActiveCounts> {
		return this.activeCounts();
	}

	async countQueued(): Promise<number> {
		return [...this.workspaces.values()].filter((w) => w.state === "queued").length;
	}

	async claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null> {
		const workspace = this.workspaces.get(claim.workspaceId);
		if (workspace?.state !== "queued") return null;
		const counts = this.activeCounts();
		if (counts.global >= claim.limits.globalActiveWorkspaces) return null;
		if (
			(counts.byPrincipal[workspace.principalId] ?? 0) >= claim.limits.perPrincipalActiveWorkspaces
		) {
			return null;
		}
		const templateLimit =
			claim.limits.perTemplateActiveWorkspaces[workspace.templateName] ??
			claim.limits.globalActiveWorkspaces;
		if ((counts.byTemplate[workspace.templateName] ?? 0) >= templateLimit) return null;
		return this.transition(workspace.id, {
			from: ["queued"],
			to: "provisioning",
			at: claim.at,
			patch: {
				provisioningMode: "cold",
				registrationDigest: claim.registrationDigest,
				registrationExpiresAt: claim.registrationExpiresAt,
				launchAttempts: workspace.launchAttempts + 1,
			},
		});
	}

	async updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void> {
		const row = this.workspaces.get(id);
		if (!row) return;
		Object.assign(row, patch);
		const changed = Object.keys(patch).some((key) => CHANGE_PATCH_KEYS.has(key));
		if (changed) row.changeSeq += 1;
		row.updatedAt = at;
		if (changed) this.notifyWorkspaceChange(id);
	}

	async waitForWorkspaceChange(
		id: string,
		afterSeq: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const current = this.workspaces.get(id);
		if (!current || current.changeSeq > afterSeq || timeoutMs <= 0) return;
		await new Promise<void>((resolve, reject) => {
			const waiters = this.changeWaiters.get(id) ?? new Set<() => void>();
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				waiters.delete(settle);
				if (waiters.size === 0) this.changeWaiters.delete(id);
			};
			const settle = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal?.reason ?? new Error("workspace change wait aborted"));
			};
			waiters.add(settle);
			this.changeWaiters.set(id, waiters);
			timer = setTimeout(settle, timeoutMs);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const latest = this.workspaces.get(id);
			if (!latest || latest.changeSeq > afterSeq) settle();
		});
	}

	async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
		const row = this.workspaces.get(id);
		if (!row) return null;
		if (!req.from.includes(row.state)) return null;
		if (!canTransition(row.state, req.to)) return null;
		const fromState = row.state;
		row.state = req.to;
		if (req.reason !== undefined) row.reasonCode = req.reason;
		if (req.patch) Object.assign(row, req.patch);
		row.changeSeq += 1;
		row.updatedAt = req.at;
		if (isTerminal(req.to)) {
			row.terminalAt = req.at;
			row.launchInput = null;
			row.registrationDigest = null;
			const current = this.conversationStates.get(id);
			if (current?.status !== "deleted") {
				this.conversationStates.set(id, {
					workspaceId: id,
					status: "retained",
					expiresAt: new Date(
						req.at.getTime() +
							parseDurationMs(row.templateSnapshot.spec.persistence.conversationRetention),
					),
					deletedAt: null,
					updatedAt: req.at,
				});
			}
		}
		this.appendHistory(row, fromState, req.to, row.reasonCode, req.at);
		this.appendWorkspaceEvent(row, req.at);
		this.notifyWorkspaceChange(id);
		return { ...row };
	}

	async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
		return this.history.filter((h) => h.workspaceId === workspaceId).map((h) => ({ ...h }));
	}

	// --- Storage, checkpoints, operations, and outputs ---

	async insertWorkspaceStorage(row: WorkspaceStorageRow): Promise<WorkspaceStorageRow> {
		const existing = [...this.storage.values()].find(
			(candidate) =>
				candidate.workspaceId === row.workspaceId &&
				!["deleted", "lost", "quarantined"].includes(candidate.state),
		);
		if (existing) return { ...existing };
		this.storage.set(row.id, { ...row });
		return { ...row };
	}

	async getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageRow | null> {
		const row = [...this.storage.values()].find(
			(candidate) =>
				candidate.workspaceId === workspaceId &&
				!["deleted", "lost", "quarantined"].includes(candidate.state),
		);
		return row ? { ...row } : null;
	}

	async getStorage(id: string): Promise<WorkspaceStorageRow | null> {
		const row = this.storage.get(id);
		return row ? { ...row } : null;
	}

	async updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date): Promise<void> {
		const row = this.storage.get(id);
		if (!row) return;
		Object.assign(row, patch);
		row.updatedAt = at;
	}

	async insertCheckpoint(row: WorkspaceCheckpointRow): Promise<WorkspaceCheckpointRow> {
		const existing = this.checkpoints.get(row.id);
		if (existing) return { ...existing };
		this.checkpoints.set(row.id, { ...row });
		return { ...row };
	}

	async getCheckpoint(id: string): Promise<WorkspaceCheckpointRow | null> {
		const row = this.checkpoints.get(id);
		return row ? { ...row } : null;
	}

	async listCheckpoints(
		principalId: string,
		filter: { workspaceId?: string; state?: CheckpointState } = {},
	): Promise<WorkspaceCheckpointRow[]> {
		return [...this.checkpoints.values()]
			.filter(
				(row) =>
					row.principalId === principalId &&
					(!filter.workspaceId || row.workspaceId === filter.workspaceId) &&
					(!filter.state || row.state === filter.state),
			)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.map((row) => ({ ...row }));
	}

	async updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date): Promise<void> {
		const row = this.checkpoints.get(id);
		if (!row) return;
		if (row.state === "ready") {
			const mutable = new Set(["state", "reasonCode", "expiresAt", "deletedAt"]);
			for (const key of Object.keys(patch)) {
				if (!mutable.has(key)) throw new Error("ready checkpoints are immutable");
			}
		}
		Object.assign(row, patch);
		row.updatedAt = at;
	}

	async insertOperation(
		row: WorkspaceOperationRow,
		options: { maxIncompleteOperations?: number } = {},
	): Promise<{ operation: WorkspaceOperationRow; created: boolean; conflict: boolean }> {
		const existing = [...this.operations.values()].find(
			(candidate) =>
				candidate.principalId === row.principalId &&
				candidate.kind === row.kind &&
				candidate.idempotencyKey === row.idempotencyKey,
		);
		if (existing) {
			return {
				operation: { ...existing },
				created: false,
				conflict: existing.requestDigest !== row.requestDigest,
			};
		}
		if (
			options.maxIncompleteOperations !== undefined &&
			[...this.operations.values()].filter((operation) =>
				["pending", "running"].includes(operation.state),
			).length >= options.maxIncompleteOperations
		) {
			throw new OperationCapacityExceededError();
		}
		this.assertOperationReferences(row);
		this.operations.set(row.id, { ...row });
		return { operation: { ...row }, created: true, conflict: false };
	}

	private assertOperationReferences(row: WorkspaceOperationRow): void {
		if (row.checkpointId && !this.checkpoints.has(row.checkpointId)) {
			throw new Error("operation checkpoint does not exist");
		}
		if (row.resultWorkspaceId && !this.workspaces.has(row.resultWorkspaceId)) {
			throw new Error("operation result workspace does not exist");
		}
	}

	async getOperation(id: string): Promise<WorkspaceOperationRow | null> {
		const row = this.operations.get(id);
		return row ? { ...row } : null;
	}

	async getOperationByIdempotency(
		principalId: string,
		kind: OperationKind,
		idempotencyKey: string,
	): Promise<WorkspaceOperationRow | null> {
		const row = [...this.operations.values()].find(
			(candidate) =>
				candidate.principalId === principalId &&
				candidate.kind === kind &&
				candidate.idempotencyKey === idempotencyKey,
		);
		return row ? { ...row } : null;
	}

	async listIncompleteOperations(): Promise<WorkspaceOperationRow[]> {
		return [...this.operations.values()]
			.filter((row) => row.state === "pending" || row.state === "running")
			.map((row) => ({ ...row }));
	}

	async updateOperation(id: string, patch: WorkspaceOperationPatch, at: Date): Promise<void> {
		const row = this.operations.get(id);
		if (!row) return;
		this.assertOperationReferences({ ...row, ...patch });
		Object.assign(row, patch);
		row.updatedAt = at;
	}

	async checkpointUsage(principalId: string | null) {
		const rows = [...this.checkpoints.values()].filter(
			(row) =>
				(!principalId || row.principalId === principalId) &&
				(row.state === "ready" || row.state === "deleting"),
		);
		return {
			count: rows.length,
			logicalBytes: rows.reduce((sum, row) => sum + (row.logicalBytes ?? 0), 0),
		};
	}

	async countIncompleteOperations(): Promise<number> {
		return [...this.operations.values()].filter(
			(row) => row.state === "pending" || row.state === "running",
		).length;
	}

	async appendOutput(input: WorkspaceOutputRow): Promise<WorkspaceOutputRow> {
		const workspace = this.workspaces.get(input.workspaceId);
		if (!workspace) throw new Error("workspace not found");
		const list = this.outputs.get(input.workspaceId) ?? [];
		const row = { ...input, seq: list.length + 1 };
		list.push(row);
		this.outputs.set(input.workspaceId, list);
		workspace.outputs = { ...workspace.outputs, [row.name]: row.value };
		workspace.updatedAt = row.occurredAt;
		return { ...row };
	}

	async listOutputs(workspaceId: string): Promise<WorkspaceOutputRow[]> {
		return (this.outputs.get(workspaceId) ?? []).map((row) => ({ ...row }));
	}

	private appendHistory(
		row: WorkspaceRow,
		from: WorkspaceState | null,
		to: WorkspaceState,
		reason: WorkspaceRow["reasonCode"],
		at: Date,
	): void {
		this.history.push({
			id: randomUUID(),
			workspaceId: row.id,
			fromState: from,
			toState: to,
			reasonCode: reason,
			occurredAt: at,
		});
	}

	private appendWorkspaceEvent(row: WorkspaceRow, at: Date): void {
		const payload = buildEventEnvelope(row, at);
		this.outbox.push({
			id: payload.id,
			workspaceId: row.id,
			eventType: payload.type,
			payload,
			occurredAt: at,
			nextAttemptAt: at,
			attemptCount: 0,
			deliveredAt: null,
			lastErrorCode: null,
		});
	}

	// --- Logs ---

	async appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void> {
		const list = this.logs.get(workspaceId) ?? [];
		let bytes = this.logBytes.get(workspaceId) ?? 0;
		let seq = list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
		for (const entry of entries) {
			if (bytes + entry.content.length > MAX_LOG_BYTES) {
				break;
			}
			seq += 1;
			bytes += entry.content.length;
			list.push({
				workspaceId,
				seq,
				stream: entry.stream,
				occurredAt: entry.occurredAt,
				content: entry.content,
			});
		}
		this.logs.set(workspaceId, list);
		this.logBytes.set(workspaceId, bytes);
	}

	async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
		return (this.logs.get(workspaceId) ?? [])
			.filter((l) => l.seq > afterSeq)
			.slice(0, limit)
			.map((l) => ({ ...l }));
	}

	async readLogTail(
		workspaceId: string,
		maxBytes: number,
	): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }> {
		const rows = this.logs.get(workspaceId) ?? [];
		const lastSeq = rows.at(-1)?.seq ?? null;
		const totalBytes = rows.reduce((sum, row) => sum + row.content.byteLength, 0);
		const combined = Buffer.concat(rows.map((row) => Buffer.from(row.content)));
		const content = combined.byteLength > maxBytes ? combined.subarray(-maxBytes) : combined;
		return {
			content: Uint8Array.from(content),
			truncated: totalBytes > maxBytes,
			lastSeq,
		};
	}

	async appendNetworkEvents(
		workspaceId: string,
		sourceSessionId: string,
		events: Parameters<Store["appendNetworkEvents"]>[2],
	): Promise<void> {
		const rows = this.networkEvents.get(workspaceId) ?? [];
		const seen = new Set(rows.map((row) => `${row.sourceSessionId}:${row.source_seq}`));
		const workspace = this.workspaces.get(workspaceId);
		if (!workspace) throw new Error("workspace.not_found");
		for (const event of events) {
			const key = `${sourceSessionId}:${event.source_seq}`;
			if (seen.has(key)) continue;
			workspace.networkEventSeq += 1;
			rows.push({ ...event, workspaceId, sourceSessionId, seq: workspace.networkEventSeq });
			seen.add(key);
		}
		this.networkEvents.set(workspaceId, rows);
	}

	async readNetworkEvents(workspaceId: string, afterSeq: number, limit: number) {
		return (this.networkEvents.get(workspaceId) ?? [])
			.filter((row) => row.seq > afterSeq)
			.slice(0, limit)
			.map((row) => ({ ...row }));
	}

	// --- Durable conversation history ---

	async appendConversationMessage(
		input: Omit<ConversationMessageRow, "seq">,
	): Promise<{ message: ConversationMessageRow; created: boolean }> {
		const state = this.conversationStates.get(input.workspaceId);
		if (state?.status === "deleted") throw new Error("conversation.deleted");
		const rows = this.conversations.get(input.workspaceId) ?? [];
		const existing = rows.find((row) => row.messageId === input.messageId);
		if (existing) return { message: { ...existing }, created: false };
		const storedBytes = this.conversationBytes.get(input.workspaceId) ?? 0;
		const inputBytes =
			Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(input.metadata));
		if (
			rows.length >= MAX_CONVERSATION_MESSAGES ||
			storedBytes + inputBytes > MAX_CONVERSATION_BYTES
		) {
			throw new Error("conversation.quota_exceeded");
		}
		const message = { ...input, seq: (rows.at(-1)?.seq ?? 0) + 1 };
		rows.push(message);
		this.conversations.set(input.workspaceId, rows);
		this.conversationBytes.set(input.workspaceId, storedBytes + inputBytes);
		if (!state) {
			this.conversationStates.set(input.workspaceId, {
				workspaceId: input.workspaceId,
				status: "retained",
				expiresAt: null,
				deletedAt: null,
				updatedAt: input.createdAt,
			});
		}
		return { message: { ...message }, created: true };
	}

	async readConversation(
		workspaceId: string,
		afterSeq: number,
		limit: number,
	): Promise<ConversationMessageRow[]> {
		return (this.conversations.get(workspaceId) ?? [])
			.filter((row) => row.seq > afterSeq)
			.slice(0, limit)
			.map((row) => ({ ...row, metadata: { ...row.metadata } }));
	}

	async getConversationState(workspaceId: string): Promise<ConversationStateRow | null> {
		const row = this.conversationStates.get(workspaceId);
		return row ? { ...row } : null;
	}

	async setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void> {
		const current = this.conversationStates.get(workspaceId);
		if (current?.status === "deleted") return;
		this.conversationStates.set(workspaceId, {
			workspaceId,
			status: "retained",
			expiresAt,
			deletedAt: null,
			updatedAt: at,
		});
	}

	async deleteConversation(workspaceId: string, at: Date): Promise<void> {
		this.conversations.delete(workspaceId);
		this.conversationBytes.delete(workspaceId);
		this.conversationStates.set(workspaceId, {
			workspaceId,
			status: "deleted",
			expiresAt: null,
			deletedAt: at,
			updatedAt: at,
		});
	}

	async pruneExpiredConversations(at: Date): Promise<number> {
		let deleted = 0;
		for (const state of this.conversationStates.values()) {
			if (state.status !== "retained" || !state.expiresAt || state.expiresAt > at) continue;
			if ((this.conversations.get(state.workspaceId)?.length ?? 0) > 0) deleted += 1;
			this.conversations.delete(state.workspaceId);
			this.conversationBytes.delete(state.workspaceId);
		}
		return deleted;
	}

	// --- Outbox ---

	async claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]> {
		const due = this.outbox
			.filter((e) => !e.deliveredAt && e.nextAttemptAt <= now && !this.claimedEvents.has(e.id))
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
			.slice(0, limit);
		for (const e of due) this.claimedEvents.add(e.id);
		return due.map((e) => ({ ...e }));
	}

	async markEventDelivered(id: string, at: Date): Promise<void> {
		const e = this.outbox.find((x) => x.id === id);
		if (e) {
			e.deliveredAt = at;
			e.attemptCount += 1;
		}
		this.claimedEvents.delete(id);
	}

	async markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
		const e = this.outbox.find((x) => x.id === id);
		if (e) {
			e.attemptCount += 1;
			e.lastErrorCode = errorCode;
			e.nextAttemptAt = nextAttemptAt;
		}
		this.claimedEvents.delete(id);
	}

	async appendEvent(
		workspaceId: string,
		eventType: string,
		payload: unknown,
		at: Date,
	): Promise<void> {
		this.outbox.push({
			id: randomUUID(),
			workspaceId,
			eventType,
			payload,
			occurredAt: at,
			nextAttemptAt: at,
			attemptCount: 0,
			deliveredAt: null,
			lastErrorCode: null,
		});
	}
}
