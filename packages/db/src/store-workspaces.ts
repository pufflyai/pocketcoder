import {
	AGENT_STATES,
	CONVERSATION_RESTORE_CAPABILITIES,
	LAUNCH_MODES,
	NETWORK_STATES,
	REASON_CODES,
	type ResolvedSource,
	type SourceDescriptor,
	type TemplateSnapshot,
	TemplateSpecSchema,
	WORKSPACE_STATES,
} from "@pstdio/pocketcoder-contracts";
import type {
	WorkspaceInsert,
	WorkspaceInsertResult,
	WorkspaceListFilter,
	WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { SQL } from "bun";
import { PostgresAuthStore } from "./store-auth";
import {
	asBoolean,
	asBytes,
	asDate,
	asDateOrNull,
	asJson,
	asJsonOr,
	enumValue,
	nullableEnumValue,
	type Row,
} from "./store-base";

export class PostgresWorkspaceStore extends PostgresAuthStore {
	protected workspaceFromRow(r: Row): WorkspaceRow {
		const rawSnapshot = asJson<TemplateSnapshot>(r.template_snapshot);
		const templateSnapshot = { ...rawSnapshot, spec: TemplateSpecSchema.parse(rawSnapshot.spec) };
		return {
			id: String(r.id),
			principalId: String(r.principal_id),
			externalId: String(r.external_id),
			idempotencyKey: String(r.idempotency_key),
			requestDigest: String(r.request_digest),
			templateId: String(r.template_id),
			templateName: String(r.template_name),
			templateVersion: String(r.template_version),
			templateDigest: String(r.template_digest),
			templateSnapshot,
			state: enumValue(r.state, WORKSPACE_STATES, "workspace state"),
			reasonCode: nullableEnumValue(r.reason_code, REASON_CODES, "workspace reason code"),
			agentState:
				r.agent_state == null
					? "unknown"
					: enumValue(r.agent_state, AGENT_STATES, "workspace agent state"),
			networkState:
				(r.network_state == null
					? null
					: enumValue(r.network_state, NETWORK_STATES, "workspace network state")) ??
				(templateSnapshot.spec.network.mode === "restricted" ? "starting" : "disabled"),
			networkEventSeq: Number(r.network_event_seq ?? 0),
			changeSeq: Number(r.change_seq ?? 1),
			failureLogTail: (r.failure_log_tail as string | null) ?? null,
			failureLogTailTruncated: asBoolean(r.failure_log_tail_truncated),
			failureLastLogSeq: r.failure_last_log_seq == null ? null : Number(r.failure_last_log_seq),
			terminalIntent: nullableEnumValue(
				r.terminal_intent,
				WORKSPACE_STATES,
				"workspace terminal intent",
			),
			launchInput: asJsonOr(r.launch_input, null),
			providerKind: (r.provider_kind as string | null) ?? null,
			providerRef: r.provider_ref == null ? null : asJson(r.provider_ref),
			provisioningMode: (r.provisioning_mode as "cold" | "warm" | null) ?? null,
			registrationDigest: asBytes(r.registration_digest),
			registrationExpiresAt: asDateOrNull(r.registration_expires_at),
			reconnectDigest: asBytes(r.reconnect_digest),
			connectionEpoch: Number(r.connection_epoch),
			connectedAt: asDateOrNull(r.connected_at),
			disconnectedAt: asDateOrNull(r.disconnected_at),
			readyAt: asDateOrNull(r.ready_at),
			lastActivityAt: asDateOrNull(r.last_activity_at),
			launchAttempts: Number(r.launch_attempts),
			health: asJson(r.health),
			metadata: asJson(r.metadata),
			deadlineAt: asDate(r.deadline_at),
			createdAt: asDate(r.created_at),
			updatedAt: asDate(r.updated_at),
			terminalAt: asDateOrNull(r.terminal_at),
			originWorkspaceId: (r.origin_workspace_id as string | null) ?? null,
			restoredFromCheckpointId: (r.restored_from_checkpoint_id as string | null) ?? null,
			sourceDescriptor: asJsonOr<SourceDescriptor | null>(r.source_descriptor, null),
			resolvedSource: asJsonOr<ResolvedSource | null>(r.resolved_source, null),
			persistenceCapability:
				r.persistence_capability == null
					? "filesystem_only"
					: enumValue(
							r.persistence_capability,
							CONVERSATION_RESTORE_CAPABILITIES,
							"workspace persistence capability",
						),
			latestCheckpointId: (r.latest_checkpoint_id as string | null) ?? null,
			launchMode:
				r.launch_mode == null
					? "create"
					: enumValue(r.launch_mode, LAUNCH_MODES, "workspace launch mode"),
			outputs: asJsonOr(r.outputs, {}),
		};
	}

	protected async workspaceInsertConflictTx(
		tx: SQL,
		row: WorkspaceInsert,
	): Promise<WorkspaceInsertResult | null> {
		const byKey = (await tx.unsafe(
			`SELECT * FROM ${this.t("workspaces")}
			 WHERE principal_id = $1 AND idempotency_key = $2`,
			[row.principalId, row.idempotencyKey],
		)) as Row[];
		if (byKey[0]) {
			const existing = this.workspaceFromRow(byKey[0]);
			return existing.requestDigest === row.requestDigest
				? { kind: "replayed", workspace: existing }
				: { kind: "conflict", conflict: "idempotency", workspace: existing };
		}
		const byExternal = (await tx.unsafe(
			`SELECT * FROM ${this.t("workspaces")}
			 WHERE principal_id = $1 AND external_id = $2
			   AND state NOT IN ('succeeded', 'failed', 'canceled', 'expired', 'preserved')`,
			[row.principalId, row.externalId],
		)) as Row[];
		return byExternal[0]
			? {
					kind: "conflict",
					conflict: "external_id",
					workspace: this.workspaceFromRow(byExternal[0]),
				}
			: null;
	}

	protected async workspaceQueueFullTx(tx: SQL, maximum: number | undefined): Promise<boolean> {
		if (maximum === undefined) return false;
		const queued = (await tx.unsafe(
			`SELECT count(*)::int AS count FROM ${this.t("workspaces")} WHERE state = 'queued'`,
		)) as Row[];
		return Number(queued[0]?.count ?? 0) >= maximum;
	}

	async insertWorkspace(
		row: WorkspaceInsert,
		options: { maxQueuedWorkspaces?: number } = {},
	): Promise<WorkspaceInsertResult> {
		return await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7350))", [
				`${this.schema}:workspace-queue`,
			]);
			const conflict = await this.workspaceInsertConflictTx(tx, row);
			if (conflict) return conflict;
			if (await this.workspaceQueueFullTx(tx, options.maxQueuedWorkspaces)) {
				return { kind: "capacity_exceeded" };
			}
			const snapshot = row.templateSnapshot;
			const inserted = (await tx.unsafe(
				`INSERT INTO ${this.t("workspaces")}
					(id, principal_id, external_id, idempotency_key, request_digest,
					 template_id, template_name, template_version, template_digest,
					 template_snapshot, state, launch_input, metadata,
					 deadline_at, created_at, updated_at, origin_workspace_id,
					 restored_from_checkpoint_id, source_descriptor, resolved_source,
					 persistence_capability, latest_checkpoint_id, launch_mode, outputs, network_state)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'queued',
						 $11::jsonb, $12::jsonb, $13, $14, $14, $15, $16, $17::jsonb,
						 $18::jsonb, $19, $20, $21, $22::jsonb, $23)
				 RETURNING *`,
				[
					row.id,
					row.principalId,
					row.externalId,
					row.idempotencyKey,
					row.requestDigest,
					row.templateId,
					snapshot.name,
					snapshot.version,
					snapshot.digest,
					JSON.stringify(snapshot),
					row.launchInput == null ? null : JSON.stringify(row.launchInput),
					JSON.stringify(row.metadata),
					row.deadlineAt,
					row.createdAt,
					row.originWorkspaceId ?? null,
					row.restoredFromCheckpointId ?? null,
					row.sourceDescriptor == null ? null : JSON.stringify(row.sourceDescriptor),
					row.resolvedSource == null ? null : JSON.stringify(row.resolvedSource),
					row.persistenceCapability ?? "filesystem_only",
					row.latestCheckpointId ?? null,
					row.launchMode ?? "create",
					JSON.stringify(row.outputs ?? {}),
					snapshot.spec.network.mode === "restricted" ? "starting" : "disabled",
				],
			)) as Row[];
			const workspace = this.workspaceFromRow(inserted[0] as Row);
			await this.appendHistoryTx(tx, workspace, null, "queued", null, row.createdAt);
			await this.appendEventTx(tx, workspace, row.createdAt);
			return { kind: "created", workspace };
		});
	}

	async getWorkspaceByIdempotency(
		principalId: string,
		idempotencyKey: string,
	): Promise<WorkspaceRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspaces")}
			 WHERE principal_id = $1 AND idempotency_key = $2`,
			[principalId, idempotencyKey],
		)) as Row[];
		return rows[0] ? this.workspaceFromRow(rows[0]) : null;
	}

	async getWorkspace(id: string): Promise<WorkspaceRow | null> {
		const rows = (await this.sql.unsafe(`SELECT * FROM ${this.t("workspaces")} WHERE id = $1`, [
			id,
		])) as Row[];
		return rows.length > 0 ? this.workspaceFromRow(rows[0] as Row) : null;
	}

	async listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]> {
		const clauses = ["principal_id = $1"];
		const params: unknown[] = [principalId];
		if (filter.externalId) {
			params.push(filter.externalId);
			clauses.push(`external_id = $${params.length}`);
		}
		if (filter.state) {
			params.push(filter.state);
			clauses.push(`state = $${params.length}`);
		}
		if (filter.template) {
			params.push(filter.template);
			clauses.push(`template_name = $${params.length}`);
		}
		if (filter.metadata) {
			params.push(JSON.stringify(filter.metadata));
			clauses.push(`metadata @> $${params.length}::jsonb`);
		}
		if (filter.createdAfter) {
			params.push(filter.createdAfter);
			clauses.push(`created_at >= $${params.length}`);
		}
		if (filter.createdBefore) {
			params.push(filter.createdBefore);
			clauses.push(`created_at < $${params.length}`);
		}
		if (filter.cursor) {
			params.push(filter.cursor);
			clauses.push(
				`(created_at, id) < (SELECT created_at, id FROM ${this.t("workspaces")}
				 WHERE id = $${params.length} AND principal_id = $1)`,
			);
		}
		params.push(filter.limit);
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspaces")} WHERE ${clauses.join(" AND ")}
				 ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
			params,
		)) as Row[];
		return rows.map((r) => this.workspaceFromRow(r));
	}
}
