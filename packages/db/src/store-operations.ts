import {
	OPERATION_KINDS,
	OPERATION_STATES,
	type OperationKind,
} from "@pstdio/pocketcoder-contracts";
import {
	OperationCapacityExceededError,
	type WorkspaceOperationPatch,
	type WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-core";

import { asDate, asDateOrNull, enumValue, type Row } from "./store-base";
import { PostgresCheckpointStore } from "./store-checkpoints";

export class PostgresOperationStore extends PostgresCheckpointStore {
	protected operationFromRow(r: Row): WorkspaceOperationRow {
		return {
			id: String(r.id),
			principalId: String(r.principal_id),
			kind: enumValue(r.kind, OPERATION_KINDS, "operation kind"),
			state: enumValue(r.state, OPERATION_STATES, "operation state"),
			idempotencyKey: String(r.idempotency_key),
			requestDigest: String(r.request_digest),
			workspaceId: (r.workspace_id as string | null) ?? null,
			checkpointId: (r.checkpoint_id as string | null) ?? null,
			resultWorkspaceId: (r.result_workspace_id as string | null) ?? null,
			reasonCode: (r.reason_code as string | null) ?? null,
			attemptCount: Number(r.attempt_count),
			createdAt: asDate(r.created_at),
			updatedAt: asDate(r.updated_at),
			completedAt: asDateOrNull(r.completed_at),
		};
	}

	async insertOperation(
		row: WorkspaceOperationRow,
		options: { maxIncompleteOperations?: number } = {},
	): Promise<{ operation: WorkspaceOperationRow; created: boolean; conflict: boolean }> {
		return await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))", [
				`${this.schema}:workspace-operations`,
			]);
			const existingRows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspace_operations")}
				 WHERE principal_id = $1 AND kind = $2 AND idempotency_key = $3`,
				[row.principalId, row.kind, row.idempotencyKey],
			)) as Row[];
			if (existingRows[0]) {
				const existing = this.operationFromRow(existingRows[0]);
				return {
					operation: existing,
					created: false,
					conflict: existing.requestDigest !== row.requestDigest,
				};
			}
			if (options.maxIncompleteOperations !== undefined) {
				const incomplete = (await tx.unsafe(
					`SELECT count(*)::int AS count FROM ${this.t("workspace_operations")}
					 WHERE state IN ('pending', 'running')`,
				)) as Row[];
				if (Number(incomplete[0]?.count ?? 0) >= options.maxIncompleteOperations) {
					throw new OperationCapacityExceededError();
				}
			}
			const rows = (await tx.unsafe(
				`INSERT INTO ${this.t("workspace_operations")}
					(id, principal_id, kind, state, idempotency_key, request_digest, workspace_id,
					 checkpoint_id, result_workspace_id, reason_code, attempt_count, created_at,
					 updated_at, completed_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
				 RETURNING *`,
				[
					row.id,
					row.principalId,
					row.kind,
					row.state,
					row.idempotencyKey,
					row.requestDigest,
					row.workspaceId,
					row.checkpointId,
					row.resultWorkspaceId,
					row.reasonCode,
					row.attemptCount,
					row.createdAt,
					row.updatedAt,
					row.completedAt,
				],
			)) as Row[];
			return {
				operation: this.operationFromRow(rows[0] as Row),
				created: true,
				conflict: false,
			};
		});
	}

	async getOperation(id: string): Promise<WorkspaceOperationRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_operations")} WHERE id = $1`,
			[id],
		)) as Row[];
		return rows[0] ? this.operationFromRow(rows[0]) : null;
	}

	async getOperationByIdempotency(
		principalId: string,
		kind: OperationKind,
		idempotencyKey: string,
	): Promise<WorkspaceOperationRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_operations")}
			 WHERE principal_id = $1 AND kind = $2 AND idempotency_key = $3`,
			[principalId, kind, idempotencyKey],
		)) as Row[];
		return rows[0] ? this.operationFromRow(rows[0]) : null;
	}

	async listIncompleteOperations(): Promise<WorkspaceOperationRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_operations")}
			 WHERE state IN ('pending', 'running') ORDER BY created_at`,
		)) as Row[];
		return rows.map((row) => this.operationFromRow(row));
	}

	async updateOperation(id: string, patch: WorkspaceOperationPatch, at: Date): Promise<void> {
		const columns: Record<string, string> = {
			state: "state",
			checkpointId: "checkpoint_id",
			resultWorkspaceId: "result_workspace_id",
			reasonCode: "reason_code",
			attemptCount: "attempt_count",
			completedAt: "completed_at",
		};
		const params: unknown[] = [id, at];
		const sets = ["updated_at = $2"];
		for (const [key, column] of Object.entries(columns)) {
			if (!(key in patch)) continue;
			params.push((patch as Record<string, unknown>)[key] ?? null);
			sets.push(`${column} = $${params.length}`);
		}
		await this.sql.unsafe(
			`UPDATE ${this.t("workspace_operations")} SET ${sets.join(", ")} WHERE id = $1`,
			params,
		);
	}

	async checkpointUsage(principalId: string | null) {
		const params: unknown[] = [];
		const principalClause = principalId
			? (() => {
					params.push(principalId);
					return `AND principal_id = $${params.length}`;
				})()
			: "";
		const rows = (await this.sql.unsafe(
			`SELECT count(*)::int AS count,
					COALESCE(sum(logical_bytes), 0)::bigint AS logical_bytes
			 FROM ${this.t("workspace_checkpoints")}
			 WHERE state IN ('ready', 'deleting') ${principalClause}`,
			params,
		)) as Array<{ count: number; logical_bytes: string | number }>;
		return {
			count: Number(rows[0]?.count ?? 0),
			logicalBytes: Number(rows[0]?.logical_bytes ?? 0),
		};
	}

	async countIncompleteOperations(): Promise<number> {
		const rows = (await this.sql.unsafe(
			`SELECT count(*)::int AS count FROM ${this.t("workspace_operations")}
			 WHERE state IN ('pending', 'running')`,
		)) as Array<{ count: number }>;
		return Number(rows[0]?.count ?? 0);
	}
}
