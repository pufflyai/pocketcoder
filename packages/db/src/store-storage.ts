import { STORAGE_STATES } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceStoragePatch, WorkspaceStorageRow } from "@pstdio/pocketcoder-runtime-core";

import { asDate, asDateOrNull, asJson, enumValue, type Row } from "./store-base";
import { PostgresWarmPoolStore } from "./store-warm-pools";

export class PostgresStorageStore extends PostgresWarmPoolStore {
	protected storageFromRow(r: Row): WorkspaceStorageRow {
		return {
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			principalId: String(r.principal_id),
			providerKind: String(r.provider_kind),
			providerRef: asJson(r.provider_ref),
			state: enumValue(r.state, STORAGE_STATES, "storage state"),
			mountManifest: asJson(r.mount_manifest),
			logicalBytes: r.logical_bytes == null ? null : Number(r.logical_bytes),
			fileCount: r.file_count == null ? null : Number(r.file_count),
			retainedUntil: asDateOrNull(r.retained_until),
			createdAt: asDate(r.created_at),
			updatedAt: asDate(r.updated_at),
			deletedAt: asDateOrNull(r.deleted_at),
			lastErrorCode: (r.last_error_code as string | null) ?? null,
		};
	}

	async insertWorkspaceStorage(row: WorkspaceStorageRow): Promise<WorkspaceStorageRow> {
		const rows = (await this.sql.unsafe(
			`INSERT INTO ${this.t("workspace_storage")}
				(id, workspace_id, principal_id, provider_kind, provider_ref, state,
				 mount_manifest, logical_bytes, file_count, retained_until, created_at,
				 updated_at, deleted_at, last_error_code)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
			 ON CONFLICT DO NOTHING RETURNING *`,
			[
				row.id,
				row.workspaceId,
				row.principalId,
				row.providerKind,
				JSON.stringify(row.providerRef),
				row.state,
				JSON.stringify(row.mountManifest),
				row.logicalBytes,
				row.fileCount,
				row.retainedUntil,
				row.createdAt,
				row.updatedAt,
				row.deletedAt,
				row.lastErrorCode,
			],
		)) as Row[];
		if (rows[0]) return this.storageFromRow(rows[0]);
		const existing = await this.getWorkspaceStorage(row.workspaceId);
		if (!existing) throw new Error("workspace storage insert conflicted without a live row");
		return existing;
	}

	async getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_storage")}
			 WHERE workspace_id = $1 AND state NOT IN ('deleted', 'lost', 'quarantined')
			 ORDER BY created_at DESC LIMIT 1`,
			[workspaceId],
		)) as Row[];
		return rows[0] ? this.storageFromRow(rows[0]) : null;
	}

	async getStorage(id: string): Promise<WorkspaceStorageRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_storage")} WHERE id = $1`,
			[id],
		)) as Row[];
		return rows[0] ? this.storageFromRow(rows[0]) : null;
	}

	async updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date): Promise<void> {
		const columns: Record<string, { name: string; json?: boolean }> = {
			providerKind: { name: "provider_kind" },
			providerRef: { name: "provider_ref", json: true },
			state: { name: "state" },
			logicalBytes: { name: "logical_bytes" },
			fileCount: { name: "file_count" },
			retainedUntil: { name: "retained_until" },
			deletedAt: { name: "deleted_at" },
			lastErrorCode: { name: "last_error_code" },
		};
		const params: unknown[] = [id, at];
		const sets = ["updated_at = $2"];
		for (const [key, column] of Object.entries(columns)) {
			if (!(key in patch)) continue;
			const value = (patch as Record<string, unknown>)[key];
			params.push(column.json && value != null ? JSON.stringify(value) : (value ?? null));
			sets.push(`${column.name} = $${params.length}${column.json ? "::jsonb" : ""}`);
		}
		await this.sql.unsafe(
			`UPDATE ${this.t("workspace_storage")} SET ${sets.join(", ")} WHERE id = $1`,
			params,
		);
	}
}
