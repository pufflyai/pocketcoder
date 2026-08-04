import { isTerminal } from "@pstdio/pocketcoder-contracts";
import type {
	WorkspaceInsert,
	WorkspaceInsertResult,
	WorkspaceListFilter,
	WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryAuthStore } from "./memory-store-auth";

export class MemoryWorkspaceStore extends MemoryAuthStore {
	protected workspaceInsertConflict(row: WorkspaceInsert): WorkspaceInsertResult | null {
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

	protected queueIsFull(maxQueuedWorkspaces: number | undefined): boolean {
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
}
