import type { OperationKind } from "@pstdio/pocketcoder-contracts";
import {
	OperationCapacityExceededError,
	type WorkspaceOperationPatch,
	type WorkspaceOperationRow,
	type WorkspaceOutputRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryPersistenceStore } from "./memory-store-persistence";

export class MemoryOperationStore extends MemoryPersistenceStore {
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

	protected assertOperationReferences(row: WorkspaceOperationRow): void {
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
}
