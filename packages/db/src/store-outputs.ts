import type { WorkspaceOutputRow } from "@pstdio/pocketcoder-runtime-core";

import { asDate, asJson, type Row } from "./store-base";
import { PostgresOperationStore } from "./store-operations";

export class PostgresOutputStore extends PostgresOperationStore {
	async appendOutput(input: WorkspaceOutputRow): Promise<WorkspaceOutputRow> {
		return await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7081))", [
				input.workspaceId,
			]);
			const seqRows = (await tx.unsafe(
				`SELECT COALESCE(MAX(seq), 0)::bigint AS seq
				 FROM ${this.t("workspace_outputs")} WHERE workspace_id = $1`,
				[input.workspaceId],
			)) as Array<{ seq: string | number }>;
			const seq = Number(seqRows[0]?.seq ?? 0) + 1;
			await tx.unsafe(
				`INSERT INTO ${this.t("workspace_outputs")}
					(workspace_id, seq, name, value, occurred_at)
				 VALUES ($1, $2, $3, $4::jsonb, $5)`,
				[input.workspaceId, seq, input.name, JSON.stringify(input.value), input.occurredAt],
			);
			await tx.unsafe(
				`UPDATE ${this.t("workspaces")}
				 SET outputs = outputs || jsonb_build_object($2::text, $3::jsonb), updated_at = $4
				 WHERE id = $1`,
				[input.workspaceId, input.name, JSON.stringify(input.value), input.occurredAt],
			);
			return { ...input, seq };
		});
	}

	async listOutputs(workspaceId: string): Promise<WorkspaceOutputRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_outputs")}
			 WHERE workspace_id = $1 ORDER BY seq`,
			[workspaceId],
		)) as Row[];
		return rows.map((row) => ({
			workspaceId: String(row.workspace_id),
			seq: Number(row.seq),
			name: String(row.name),
			value: asJson(row.value),
			occurredAt: asDate(row.occurred_at),
		}));
	}
}
