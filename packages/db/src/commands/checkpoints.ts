import {
  CHECKPOINT_STATES,
  type CheckpointManifest,
  type CheckpointState,
  CONVERSATION_RESTORE_CAPABILITIES,
} from "@pstdio/pocketcoder-contracts";
import type {
  WorkspaceCheckpointPatch,
  WorkspaceCheckpointRow,
} from "@pstdio/pocketcoder-runtime-core";

import { asDate, asDateOrNull, asJson, enumValue, type Row } from "./base";
import { StorageCommands } from "./storage";

export class CheckpointCommands extends StorageCommands {
  protected checkpointFromRow(r: Row): WorkspaceCheckpointRow {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      principalId: String(r.principal_id),
      storageId: String(r.storage_id),
      parentCheckpointId: (r.parent_checkpoint_id as string | null) ?? null,
      state: enumValue(r.state, CHECKPOINT_STATES, "checkpoint state"),
      reasonCode: (r.reason_code as string | null) ?? null,
      providerKind: String(r.provider_kind),
      providerRef: r.provider_ref == null ? null : asJson(r.provider_ref),
      templateSnapshot: asJson(r.template_snapshot),
      templateDigest: String(r.template_digest),
      sourceProvenance: r.source_provenance == null ? null : asJson(r.source_provenance),
      manifest: r.manifest == null ? null : asJson<CheckpointManifest>(r.manifest),
      manifestDigest: (r.manifest_digest as string | null) ?? null,
      logicalBytes: r.logical_bytes == null ? null : Number(r.logical_bytes),
      storedBytes: r.stored_bytes == null ? null : Number(r.stored_bytes),
      fileCount: r.file_count == null ? null : Number(r.file_count),
      conversationRestore: enumValue(
        r.conversation_restore,
        CONVERSATION_RESTORE_CAPABILITIES,
        "checkpoint conversation restore capability",
      ),
      label: (r.label as string | null) ?? null,
      createdAt: asDate(r.created_at),
      updatedAt: asDate(r.updated_at),
      readyAt: asDateOrNull(r.ready_at),
      expiresAt: asDateOrNull(r.expires_at),
      deletedAt: asDateOrNull(r.deleted_at),
    };
  }

  async insertCheckpoint(row: WorkspaceCheckpointRow): Promise<WorkspaceCheckpointRow> {
    const rows = (await this.sql.unsafe(
      `INSERT INTO ${this.t("workspace_checkpoints")}
        (id, workspace_id, principal_id, storage_id, parent_checkpoint_id, state,
         reason_code, provider_kind, provider_ref, template_snapshot, template_digest,
         source_provenance, manifest, manifest_digest, logical_bytes, stored_bytes,
         file_count, conversation_restore, label, created_at, updated_at, ready_at,
         expires_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11,
         $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21,
         $22, $23, $24)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING *`,
      [
        row.id,
        row.workspaceId,
        row.principalId,
        row.storageId,
        row.parentCheckpointId,
        row.state,
        row.reasonCode,
        row.providerKind,
        row.providerRef == null ? null : JSON.stringify(row.providerRef),
        JSON.stringify(row.templateSnapshot),
        row.templateDigest,
        row.sourceProvenance == null ? null : JSON.stringify(row.sourceProvenance),
        row.manifest == null ? null : JSON.stringify(row.manifest),
        row.manifestDigest,
        row.logicalBytes,
        row.storedBytes,
        row.fileCount,
        row.conversationRestore,
        row.label,
        row.createdAt,
        row.updatedAt,
        row.readyAt,
        row.expiresAt,
        row.deletedAt,
      ],
    )) as Row[];
    return this.checkpointFromRow(rows[0] as Row);
  }

  async getCheckpoint(id: string): Promise<WorkspaceCheckpointRow | null> {
    const rows = (await this.sql.unsafe(
      `SELECT * FROM ${this.t("workspace_checkpoints")} WHERE id = $1`,
      [id],
    )) as Row[];
    return rows[0] ? this.checkpointFromRow(rows[0]) : null;
  }

  async listCheckpoints(
    principalId: string,
    filter: { workspaceId?: string; state?: CheckpointState } = {},
  ): Promise<WorkspaceCheckpointRow[]> {
    const params: unknown[] = [principalId];
    const clauses = ["principal_id = $1"];
    if (filter.workspaceId) {
      params.push(filter.workspaceId);
      clauses.push(`workspace_id = $${params.length}`);
    }
    if (filter.state) {
      params.push(filter.state);
      clauses.push(`state = $${params.length}`);
    }
    const rows = (await this.sql.unsafe(
      `SELECT * FROM ${this.t("workspace_checkpoints")}
       WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
      params,
    )) as Row[];
    return rows.map((row) => this.checkpointFromRow(row));
  }

  async updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date): Promise<void> {
    const columns: Record<string, { name: string; json?: boolean }> = {
      state: { name: "state" },
      reasonCode: { name: "reason_code" },
      providerKind: { name: "provider_kind" },
      providerRef: { name: "provider_ref", json: true },
      manifest: { name: "manifest", json: true },
      manifestDigest: { name: "manifest_digest" },
      logicalBytes: { name: "logical_bytes" },
      storedBytes: { name: "stored_bytes" },
      fileCount: { name: "file_count" },
      conversationRestore: { name: "conversation_restore" },
      readyAt: { name: "ready_at" },
      expiresAt: { name: "expires_at" },
      deletedAt: { name: "deleted_at" },
    };
    const current = await this.getCheckpoint(id);
    if (!current) return;
    if (current.state === "ready") {
      for (const key of Object.keys(patch)) {
        if (!["state", "reasonCode", "expiresAt", "deletedAt"].includes(key)) {
          throw new Error("ready checkpoints are immutable");
        }
      }
    }
    const params: unknown[] = [id, at];
    const sets = ["updated_at = $2"];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      params.push(column.json && value != null ? JSON.stringify(value) : (value ?? null));
      sets.push(`${column.name} = $${params.length}${column.json ? "::jsonb" : ""}`);
    }
    await this.sql.unsafe(
      `UPDATE ${this.t("workspace_checkpoints")} SET ${sets.join(", ")} WHERE id = $1`,
      params,
    );
  }
}
