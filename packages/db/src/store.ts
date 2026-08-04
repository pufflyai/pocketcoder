// biome-ignore-all lint/style/noExcessiveLinesPerFile: The PostgreSQL Store is one auditable implementation of the shared transactional contract.
import { randomUUID } from "node:crypto";
import {
	type CheckpointManifest,
	type CheckpointState,
	type ConversationRestoreCapability,
	canTransition,
	isTerminal,
	type LaunchMode,
	type OperationKind,
	type OperationState,
	parseDurationMs,
	type ReasonCode,
	type ResolvedSource,
	type SourceDescriptor,
	type StorageState,
	type TemplateSnapshot,
	TemplateSpecSchema,
	type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import {
	type ActiveCounts,
	buildEventEnvelope,
	type ConversationMessageRow,
	type ConversationStateRow,
	type LogRow,
	type MachineKeyRow,
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
	type WorkspaceCheckpointPatch,
	type WorkspaceCheckpointRow,
	type WorkspaceInsert,
	type WorkspaceListFilter,
	type WorkspaceOperationPatch,
	type WorkspaceOperationRow,
	type WorkspaceOutputRow,
	type WorkspacePatch,
	type WorkspaceRow,
	type WorkspaceStoragePatch,
	type WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import { migrate } from "./migrate";
import { assertValidSchema } from "./schema";

// PostgreSQL implementation of the Store contract. All identifiers are
// qualified with the configured schema; the runtime never reads or writes
// another schema.

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 100_000;
const CLAIM_LEASE_MS = 60_000;

type Row = Record<string, unknown>;

function pgTextArray(items: readonly string[]): string {
	return `{${items.map((i) => `"${i.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

function textArray(value: unknown): string[] {
	if (Array.isArray(value)) return value as string[];
	if (typeof value === "string") {
		const inner = value.replace(/^\{|\}$/g, "");
		if (inner === "") return [];
		return inner.split(",").map((s) => s.replace(/^"|"$/g, "").replaceAll('\\"', '"'));
	}
	return [];
}

function asDate(value: unknown): Date {
	return value instanceof Date ? value : new Date(String(value));
}

function asDateOrNull(value: unknown): Date | null {
	return value == null ? null : asDate(value);
}

function asBytes(value: unknown): Uint8Array | null {
	if (value == null) return null;
	if (value instanceof Uint8Array) return value;
	if (typeof value === "string" && value.startsWith("\\x")) {
		return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
	}
	return null;
}

function asJson<T>(value: unknown): T {
	if (typeof value === "string") return JSON.parse(value) as T;
	return value as T;
}

function asBoolean(value: unknown): boolean {
	return value === true || value === 1 || value === "true";
}

export class PostgresStore implements Store {
	private readonly sql: SQL;
	private readonly schema: string;
	private changeWaiters = new Map<string, Set<() => void>>();

	constructor(databaseUrl: string, schema = "pocketcoder") {
		this.schema = assertValidSchema(schema);
		this.sql = new SQL(databaseUrl);
	}

	private t(table: string): string {
		return `"${this.schema}"."${table}"`;
	}

	async init(): Promise<void> {
		await migrate(this.sql, this.schema);
	}

	async close(): Promise<void> {
		for (const waiters of this.changeWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.changeWaiters.clear();
		await this.sql.end();
	}

	private notifyWorkspaceChange(id: string): void {
		const waiters = this.changeWaiters.get(id);
		if (!waiters) return;
		this.changeWaiters.delete(id);
		for (const resolve of waiters) resolve();
	}

	// --- Templates ---

	private templateFromRow(r: Row): TemplateRow {
		return {
			id: String(r.id),
			name: String(r.name),
			version: String(r.version),
			digest: String(r.digest),
			description: (r.description as string | null) ?? null,
			spec: TemplateSpecSchema.parse(asJson(r.spec)),
			status: r.status as TemplateStatus,
			createdAt: asDate(r.created_at),
			retiredAt: asDateOrNull(r.retired_at),
		};
	}

	async upsertTemplate(input: TemplateUpsert): Promise<UpsertResult> {
		return await this.sql.begin(async (tx) => {
			const existing = (await tx.unsafe(
				`SELECT * FROM ${this.t("templates")} WHERE name = $1 AND version = $2 FOR UPDATE`,
				[input.name, input.version],
			)) as Row[];
			if (existing.length > 0) {
				const row = this.templateFromRow(existing[0] as Row);
				return { row, created: false, conflict: row.digest !== input.digest };
			}
			await tx.unsafe(
				`UPDATE ${this.t("templates")} SET status = 'available' WHERE name = $1 AND status = 'active'`,
				[input.name],
			);
			const inserted = (await tx.unsafe(
				`INSERT INTO ${this.t("templates")}
					(id, name, version, digest, description, spec, status, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', now())
				 RETURNING *`,
				[
					randomUUID(),
					input.name,
					input.version,
					input.digest,
					input.description,
					JSON.stringify(input.spec),
				],
			)) as Row[];
			return { row: this.templateFromRow(inserted[0] as Row), created: true, conflict: false };
		});
	}

	async listTemplates(names: string[] | null): Promise<TemplateRow[]> {
		const rows = (
			names
				? await this.sql.unsafe(
						`SELECT * FROM ${this.t("templates")} WHERE name = ANY($1::text[]) ORDER BY name, created_at`,
						[pgTextArray(names)],
					)
				: await this.sql.unsafe(`SELECT * FROM ${this.t("templates")} ORDER BY name, created_at`)
		) as Row[];
		return rows.map((r) => this.templateFromRow(r));
	}

	async getTemplate(name: string, version?: string): Promise<TemplateRow | null> {
		const rows = (
			version
				? await this.sql.unsafe(
						`SELECT * FROM ${this.t("templates")} WHERE name = $1 AND version = $2`,
						[name, version],
					)
				: await this.sql.unsafe(
						`SELECT * FROM ${this.t("templates")}
						 WHERE name = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
						[name],
					)
		) as Row[];
		return rows.length > 0 ? this.templateFromRow(rows[0] as Row) : null;
	}

	async setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void> {
		await this.sql.unsafe(
			`UPDATE ${this.t("templates")}
			 SET status = $3, retired_at = CASE WHEN $3 = 'retired' THEN now() ELSE NULL END
			 WHERE name = $1 AND version = $2`,
			[name, version, status],
		);
	}

	private warmPoolRuntimeFromRow(r: Row): WarmPoolRuntimeRow {
		return {
			id: String(r.id),
			templateId: String(r.template_id),
			templateName: String(r.template_name),
			templateVersion: String(r.template_version),
			templateDigest: String(r.template_digest),
			driverKind: String(r.driver_kind),
			eligibilityFingerprint: String(r.eligibility_fingerprint),
			state: r.state as WarmPoolRuntimeRow["state"],
			providerRef: r.provider_ref == null ? null : asJson(r.provider_ref),
			enrollmentDigest: asBytes(r.enrollment_digest),
			enrollmentExpiresAt: asDateOrNull(r.enrollment_expires_at),
			workspaceId: (r.workspace_id as string | null) ?? null,
			createdAt: asDate(r.created_at),
			updatedAt: asDate(r.updated_at),
			readyAt: asDateOrNull(r.ready_at),
			leasedAt: asDateOrNull(r.leased_at),
			failureCode: (r.failure_code as string | null) ?? null,
		};
	}

	async insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow> {
		const rows = (await this.sql.unsafe(
			`INSERT INTO ${this.t("warm_pool_runtimes")}
			 (id, template_id, template_name, template_version, template_digest, driver_kind,
			  eligibility_fingerprint, state, provider_ref, enrollment_digest,
			  enrollment_expires_at, workspace_id, created_at, updated_at, ready_at,
			  leased_at, failure_code)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)
			 ON CONFLICT (id) DO NOTHING RETURNING *`,
			[
				row.id,
				row.templateId,
				row.templateName,
				row.templateVersion,
				row.templateDigest,
				row.driverKind,
				row.eligibilityFingerprint,
				row.state,
				row.providerRef == null ? null : JSON.stringify(row.providerRef),
				row.enrollmentDigest,
				row.enrollmentExpiresAt,
				row.workspaceId,
				row.createdAt,
				row.updatedAt,
				row.readyAt,
				row.leasedAt,
				row.failureCode,
			],
		)) as Row[];
		return rows[0]
			? this.warmPoolRuntimeFromRow(rows[0])
			: ((await this.getWarmPoolRuntime(row.id)) as WarmPoolRuntimeRow);
	}

	async getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("warm_pool_runtimes")} WHERE id = $1`,
			[id],
		)) as Row[];
		return rows[0] ? this.warmPoolRuntimeFromRow(rows[0]) : null;
	}

	async listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("warm_pool_runtimes")} ORDER BY created_at`,
		)) as Row[];
		return rows.map((row) => this.warmPoolRuntimeFromRow(row));
	}

	async updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void> {
		const columns: Record<string, string> = {
			state: "state",
			providerRef: "provider_ref",
			enrollmentDigest: "enrollment_digest",
			enrollmentExpiresAt: "enrollment_expires_at",
			workspaceId: "workspace_id",
			readyAt: "ready_at",
			leasedAt: "leased_at",
			failureCode: "failure_code",
		};
		const params: unknown[] = [id, at];
		const sets = ["updated_at = $2"];
		for (const [key, column] of Object.entries(columns)) {
			if (!(key in patch)) continue;
			const value = (patch as Record<string, unknown>)[key] ?? null;
			params.push(key === "providerRef" && value !== null ? JSON.stringify(value) : value);
			sets.push(`${column} = $${params.length}${key === "providerRef" ? "::jsonb" : ""}`);
		}
		await this.sql.unsafe(
			`UPDATE ${this.t("warm_pool_runtimes")} SET ${sets.join(", ")} WHERE id = $1`,
			params,
		);
	}

	async claimWarmPoolRuntime(
		claim: WarmPoolClaim,
	): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null> {
		const result = await this.sql.begin(async (tx) => {
			const workspaceRows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")} WHERE id = $1 FOR UPDATE`,
				[claim.workspaceId],
			)) as Row[];
			const current = workspaceRows[0] ? this.workspaceFromRow(workspaceRows[0]) : null;
			if (current?.state !== "queued") return null;
			const runtimeRows = (await tx.unsafe(
				`SELECT * FROM ${this.t("warm_pool_runtimes")}
				 WHERE template_digest = $1 AND driver_kind = $2 AND eligibility_fingerprint = $3
				   AND state = 'ready' AND provider_ref IS NOT NULL
				 ORDER BY ready_at FOR UPDATE SKIP LOCKED LIMIT 1`,
				[claim.templateDigest, claim.driverKind, claim.eligibilityFingerprint],
			)) as Row[];
			if (!runtimeRows[0]) return null;
			const runtime = this.warmPoolRuntimeFromRow(runtimeRows[0]);
			const leasedRows = (await tx.unsafe(
				`UPDATE ${this.t("warm_pool_runtimes")}
				 SET state='leasing', workspace_id=$2, leased_at=$3, updated_at=$3
				 WHERE id=$1 AND state='ready' RETURNING *`,
				[runtime.id, current.id, claim.at],
			)) as Row[];
			if (!leasedRows[0]) return null;
			const updatedRows = (await tx.unsafe(
				`UPDATE ${this.t("workspaces")}
				 SET state='provisioning', provisioning_mode='warm', provider_kind=$2,
				     provider_ref=$3::jsonb, registration_digest=$4,
				     registration_expires_at=$5, launch_attempts=launch_attempts+1,
				     updated_at=$6, change_seq=change_seq+1
				 WHERE id=$1 AND state='queued' RETURNING *`,
				[
					current.id,
					runtime.driverKind,
					JSON.stringify(runtime.providerRef),
					claim.registrationDigest,
					claim.registrationExpiresAt,
					claim.at,
				],
			)) as Row[];
			if (!updatedRows[0]) throw new Error("warm_pool.claim_workspace_race");
			const workspace = this.workspaceFromRow(updatedRows[0]);
			await this.appendHistoryTx(tx, workspace, "queued", "provisioning", null, claim.at);
			await this.appendEventTx(tx, workspace, claim.at);
			return { runtime: this.warmPoolRuntimeFromRow(leasedRows[0]), workspace };
		});
		if (result) this.notifyWorkspaceChange(claim.workspaceId);
		return result;
	}

	// --- Principals and keys ---

	private principalFromRow(r: Row): PrincipalRow {
		return {
			id: String(r.id),
			name: String(r.name),
			scopes: textArray(r.scopes),
			templateNames: textArray(r.template_names),
			disabledAt: asDateOrNull(r.disabled_at),
			createdAt: asDate(r.created_at),
		};
	}

	async createPrincipal(
		name: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow> {
		const rows = (await this.sql.unsafe(
			`INSERT INTO ${this.t("principals")} (id, name, scopes, template_names, created_at)
			 VALUES ($1, $2, $3::text[], $4::text[], now()) RETURNING *`,
			[randomUUID(), name, pgTextArray(scopes), pgTextArray(templateNames)],
		)) as Row[];
		return this.principalFromRow(rows[0] as Row);
	}

	async getPrincipalByName(name: string): Promise<PrincipalRow | null> {
		const rows = (await this.sql.unsafe(`SELECT * FROM ${this.t("principals")} WHERE name = $1`, [
			name,
		])) as Row[];
		return rows.length > 0 ? this.principalFromRow(rows[0] as Row) : null;
	}

	async listPrincipals(): Promise<PrincipalRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("principals")} ORDER BY name`,
		)) as Row[];
		return rows.map((r) => this.principalFromRow(r));
	}

	async updatePrincipal(
		id: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow | null> {
		const updated = (await this.sql.unsafe(
			`UPDATE ${this.t("principals")} SET scopes = $2::text[], template_names = $3::text[]
				 WHERE id = $1 RETURNING *`,
			[id, pgTextArray(scopes), pgTextArray(templateNames)],
		)) as Row[];
		return updated[0] ? this.principalFromRow(updated[0]) : null;
	}

	async setPrincipalDisabled(id: string, disabled: boolean): Promise<void> {
		await this.sql.unsafe(
			`UPDATE ${this.t("principals")}
			 SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
			[id, disabled],
		);
	}

	async insertMachineKey(row: MachineKeyRow): Promise<void> {
		await this.sql.unsafe(
			`INSERT INTO ${this.t("machine_keys")}
				(id, principal_id, secret_digest, scopes, created_at, expires_at, revoked_at, last_used_at)
			 VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)`,
			[
				row.id,
				row.principalId,
				row.secretDigest,
				pgTextArray(row.scopes),
				row.createdAt,
				row.expiresAt,
				row.revokedAt,
				row.lastUsedAt,
			],
		);
	}

	async getMachineKeyWithPrincipal(
		keyId: string,
	): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null> {
		const rows = (await this.sql.unsafe(
			`SELECT k.id AS k_id, k.principal_id, k.secret_digest, k.scopes AS k_scopes,
					k.created_at AS k_created_at, k.expires_at, k.revoked_at, k.last_used_at,
					p.id AS p_id, p.name, p.scopes AS p_scopes, p.template_names,
					p.disabled_at, p.created_at AS p_created_at
			 FROM ${this.t("machine_keys")} k
			 JOIN ${this.t("principals")} p ON p.id = k.principal_id
			 WHERE k.id = $1`,
			[keyId],
		)) as Row[];
		const r = rows[0];
		if (!r) return null;
		const digest = asBytes(r.secret_digest);
		if (!digest) return null;
		return {
			key: {
				id: String(r.k_id),
				principalId: String(r.principal_id),
				secretDigest: digest,
				scopes: textArray(r.k_scopes),
				createdAt: asDate(r.k_created_at),
				expiresAt: asDateOrNull(r.expires_at),
				revokedAt: asDateOrNull(r.revoked_at),
				lastUsedAt: asDateOrNull(r.last_used_at),
			},
			principal: {
				id: String(r.p_id),
				name: String(r.name),
				scopes: textArray(r.p_scopes),
				templateNames: textArray(r.template_names),
				disabledAt: asDateOrNull(r.disabled_at),
				createdAt: asDate(r.p_created_at),
			},
		};
	}

	async revokeMachineKey(keyId: string, at: Date): Promise<boolean> {
		const rows = (await this.sql.unsafe(
			`UPDATE ${this.t("machine_keys")} SET revoked_at = $2
			 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
			[keyId, at],
		)) as Row[];
		return rows.length > 0;
	}

	async touchMachineKey(keyId: string, at: Date): Promise<void> {
		// Rate-limited: only rewrite when stale by more than a minute.
		await this.sql.unsafe(
			`UPDATE ${this.t("machine_keys")} SET last_used_at = $2
			 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '60 seconds')`,
			[keyId, at],
		);
	}

	// --- Workspaces ---

	private workspaceFromRow(r: Row): WorkspaceRow {
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
			templateSnapshot: {
				...asJson<TemplateSnapshot>(r.template_snapshot),
				spec: TemplateSpecSchema.parse(asJson<TemplateSnapshot>(r.template_snapshot).spec),
			},
			state: r.state as WorkspaceState,
			reasonCode: (r.reason_code as ReasonCode | null) ?? null,
			agentState: (r.agent_state as WorkspaceRow["agentState"] | null) ?? "unknown",
			changeSeq: Number(r.change_seq ?? 1),
			failureLogTail: (r.failure_log_tail as string | null) ?? null,
			failureLogTailTruncated: asBoolean(r.failure_log_tail_truncated),
			failureLastLogSeq: r.failure_last_log_seq == null ? null : Number(r.failure_last_log_seq),
			terminalIntent: (r.terminal_intent as WorkspaceState | null) ?? null,
			launchInput: r.launch_input == null ? null : asJson(r.launch_input),
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
			sourceDescriptor:
				r.source_descriptor == null ? null : asJson<SourceDescriptor>(r.source_descriptor),
			resolvedSource: r.resolved_source == null ? null : asJson<ResolvedSource>(r.resolved_source),
			persistenceCapability:
				(r.persistence_capability as ConversationRestoreCapability | null) ?? "filesystem_only",
			latestCheckpointId: (r.latest_checkpoint_id as string | null) ?? null,
			launchMode: (r.launch_mode as LaunchMode | null) ?? "create",
			outputs: r.outputs == null ? {} : asJson(r.outputs),
		};
	}

	async insertWorkspace(
		row: WorkspaceInsert,
	): Promise<{ workspace: WorkspaceRow; created: boolean; conflict: boolean }> {
		return await this.sql.begin(async (tx) => {
			const byKey = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")}
				 WHERE principal_id = $1 AND idempotency_key = $2`,
				[row.principalId, row.idempotencyKey],
			)) as Row[];
			if (byKey.length > 0) {
				const existing = this.workspaceFromRow(byKey[0] as Row);
				return {
					workspace: existing,
					created: false,
					conflict: existing.requestDigest !== row.requestDigest,
				};
			}
			const byExternal = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")}
				 WHERE principal_id = $1 AND external_id = $2
				   AND state NOT IN ('succeeded', 'failed', 'canceled', 'expired', 'preserved')`,
				[row.principalId, row.externalId],
			)) as Row[];
			if (byExternal.length > 0) {
				return {
					workspace: this.workspaceFromRow(byExternal[0] as Row),
					created: false,
					conflict: true,
				};
			}
			const snapshot = row.templateSnapshot;
			const inserted = (await tx.unsafe(
				`INSERT INTO ${this.t("workspaces")}
					(id, principal_id, external_id, idempotency_key, request_digest,
					 template_id, template_name, template_version, template_digest,
					 template_snapshot, state, launch_input, metadata,
					 deadline_at, created_at, updated_at, origin_workspace_id,
					 restored_from_checkpoint_id, source_descriptor, resolved_source,
					 persistence_capability, latest_checkpoint_id, launch_mode, outputs)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'queued',
						 $11::jsonb, $12::jsonb, $13, $14, $14, $15, $16, $17::jsonb,
						 $18::jsonb, $19, $20, $21, $22::jsonb)
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
				],
			)) as Row[];
			const workspace = this.workspaceFromRow(inserted[0] as Row);
			await this.appendHistoryTx(tx, workspace, null, "queued", null, row.createdAt);
			await this.appendEventTx(tx, workspace, row.createdAt);
			return { workspace, created: true, conflict: false };
		});
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

	async listQueued(limit: number): Promise<WorkspaceRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspaces")} WHERE state = 'queued'
			 ORDER BY created_at ASC LIMIT $1`,
			[limit],
		)) as Row[];
		return rows.map((r) => this.workspaceFromRow(r));
	}

	async listNonterminal(): Promise<WorkspaceRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspaces")}
			 WHERE state NOT IN ('succeeded', 'failed', 'canceled', 'expired', 'preserved')`,
		)) as Row[];
		return rows.map((r) => this.workspaceFromRow(r));
	}

	async countActive(): Promise<ActiveCounts> {
		const rows = (await this.sql.unsafe(
			`SELECT principal_id, template_name, count(*)::int AS n
			 FROM ${this.t("workspaces")}
			 WHERE state IN ('provisioning', 'connected', 'ready', 'preserving', 'terminating')
			 GROUP BY principal_id, template_name`,
		)) as Array<{ principal_id: string; template_name: string; n: number }>;
		const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
		for (const r of rows) {
			counts.global += r.n;
			counts.byPrincipal[r.principal_id] = (counts.byPrincipal[r.principal_id] ?? 0) + r.n;
			counts.byTemplate[r.template_name] = (counts.byTemplate[r.template_name] ?? 0) + r.n;
		}
		return counts;
	}

	async countQueued(): Promise<number> {
		const rows = (await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${this.t("workspaces")} WHERE state = 'queued'`,
		)) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	private static readonly PATCH_COLUMNS: Record<string, string> = {
		terminalIntent: "terminal_intent",
		launchInput: "launch_input",
		providerKind: "provider_kind",
		providerRef: "provider_ref",
		provisioningMode: "provisioning_mode",
		registrationDigest: "registration_digest",
		registrationExpiresAt: "registration_expires_at",
		reconnectDigest: "reconnect_digest",
		connectionEpoch: "connection_epoch",
		connectedAt: "connected_at",
		disconnectedAt: "disconnected_at",
		readyAt: "ready_at",
		lastActivityAt: "last_activity_at",
		launchAttempts: "launch_attempts",
		health: "health",
		agentState: "agent_state",
		failureLogTail: "failure_log_tail",
		failureLogTailTruncated: "failure_log_tail_truncated",
		failureLastLogSeq: "failure_last_log_seq",
		resolvedSource: "resolved_source",
		persistenceCapability: "persistence_capability",
		latestCheckpointId: "latest_checkpoint_id",
		outputs: "outputs",
	};

	private static readonly JSONB_PATCH_KEYS = new Set([
		"launchInput",
		"providerRef",
		"health",
		"resolvedSource",
		"outputs",
	]);

	private static readonly CHANGE_PATCH_KEYS = new Set([
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

	private patchSql(patch: WorkspacePatch, params: unknown[]): string[] {
		const sets: string[] = [];
		for (const [key, column] of Object.entries(PostgresStore.PATCH_COLUMNS)) {
			if (!(key in patch)) continue;
			const value = (patch as Record<string, unknown>)[key];
			if (PostgresStore.JSONB_PATCH_KEYS.has(key)) {
				params.push(value == null ? null : JSON.stringify(value));
				sets.push(`${column} = $${params.length}::jsonb`);
			} else {
				params.push(value ?? null);
				sets.push(`${column} = $${params.length}`);
			}
		}
		return sets;
	}

	async updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void> {
		const params: unknown[] = [id, at];
		const sets = this.patchSql(patch, params);
		const bumpsChange = Object.keys(patch).some((key) => PostgresStore.CHANGE_PATCH_KEYS.has(key));
		await this.sql.unsafe(
			`UPDATE ${this.t("workspaces")} SET updated_at = $2${
				bumpsChange ? ", change_seq = change_seq + 1" : ""
			}${sets.length ? `, ${sets.join(", ")}` : ""}
			 WHERE id = $1`,
			params,
		);
		if (bumpsChange) this.notifyWorkspaceChange(id);
	}

	async waitForWorkspaceChange(
		id: string,
		afterSeq: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (timeoutMs <= 0) return;
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
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			waiters.add(settle);
			this.changeWaiters.set(id, waiters);
			timer = setTimeout(settle, timeoutMs);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			void this.getWorkspace(id)
				.then((workspace) => {
					if (!workspace || workspace.changeSeq > afterSeq) settle();
				})
				.catch(fail);
		});
	}

	async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
		const workspace = await this.sql.begin(async (tx) => {
			const rows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")} WHERE id = $1 FOR UPDATE`,
				[id],
			)) as Row[];
			const current = rows[0] ? this.workspaceFromRow(rows[0] as Row) : null;
			if (!current) return null;
			if (!req.from.includes(current.state)) return null;
			if (!canTransition(current.state, req.to)) return null;

			const params: unknown[] = [id, req.to, req.at];
			const sets = [`state = $2`, `updated_at = $3`, "change_seq = change_seq + 1"];
			if (req.reason !== undefined) {
				params.push(req.reason);
				sets.push(`reason_code = $${params.length}`);
			}
			const patch = { ...(req.patch ?? {}) };
			if (isTerminal(req.to)) {
				params.push(req.at);
				sets.push(`terminal_at = $${params.length}`);
				sets.push("launch_input = NULL", "registration_digest = NULL");
				// Postgres rejects duplicate assignments to one column, so
				// patch keys covered by the terminal clears are dropped.
				delete patch.launchInput;
				delete patch.registrationDigest;
			}
			const patchSets = this.patchSql(patch, params);
			sets.push(...patchSets);
			const updated = (await tx.unsafe(
				`UPDATE ${this.t("workspaces")} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
				params,
			)) as Row[];
			const workspace = this.workspaceFromRow(updated[0] as Row);
			await this.appendHistoryTx(
				tx,
				workspace,
				current.state,
				req.to,
				workspace.reasonCode,
				req.at,
			);
			await this.appendEventTx(tx, workspace, req.at);
			if (isTerminal(req.to)) {
				const expiresAt = new Date(
					req.at.getTime() +
						parseDurationMs(workspace.templateSnapshot.spec.persistence.conversationRetention),
				);
				await tx.unsafe(
					`INSERT INTO ${this.t("workspace_conversations")}
					 (workspace_id, status, expires_at, deleted_at, updated_at)
					 VALUES ($1, 'retained', $2, NULL, $3)
					 ON CONFLICT (workspace_id) DO UPDATE
					 SET expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
					 WHERE ${this.t("workspace_conversations")}.status <> 'deleted'`,
					[workspace.id, expiresAt, req.at],
				);
			}
			return workspace;
		});
		if (workspace) this.notifyWorkspaceChange(id);
		return workspace;
	}

	async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_state_history")}
			 WHERE workspace_id = $1 ORDER BY occurred_at ASC`,
			[workspaceId],
		)) as Row[];
		return rows.map((r) => ({
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			fromState: (r.from_state as WorkspaceState | null) ?? null,
			toState: r.to_state as WorkspaceState,
			reasonCode: (r.reason_code as ReasonCode | null) ?? null,
			occurredAt: asDate(r.occurred_at),
		}));
	}

	// --- Storage, checkpoints, operations, and outputs ---

	private storageFromRow(r: Row): WorkspaceStorageRow {
		return {
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			principalId: String(r.principal_id),
			providerKind: String(r.provider_kind),
			providerRef: asJson(r.provider_ref),
			state: r.state as StorageState,
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

	private checkpointFromRow(r: Row): WorkspaceCheckpointRow {
		return {
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			principalId: String(r.principal_id),
			storageId: String(r.storage_id),
			parentCheckpointId: (r.parent_checkpoint_id as string | null) ?? null,
			state: r.state as CheckpointState,
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
			conversationRestore: r.conversation_restore as ConversationRestoreCapability,
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

	private operationFromRow(r: Row): WorkspaceOperationRow {
		return {
			id: String(r.id),
			principalId: String(r.principal_id),
			kind: r.kind as OperationKind,
			state: r.state as OperationState,
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
	): Promise<{ operation: WorkspaceOperationRow; created: boolean; conflict: boolean }> {
		const existing = await this.getOperationByIdempotency(
			row.principalId,
			row.kind,
			row.idempotencyKey,
		);
		if (existing) {
			return {
				operation: existing,
				created: false,
				conflict: existing.requestDigest !== row.requestDigest,
			};
		}
		const rows = (await this.sql.unsafe(
			`INSERT INTO ${this.t("workspace_operations")}
				(id, principal_id, kind, state, idempotency_key, request_digest, workspace_id,
				 checkpoint_id, result_workspace_id, reason_code, attempt_count, created_at,
				 updated_at, completed_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			 ON CONFLICT (principal_id, kind, idempotency_key) DO NOTHING RETURNING *`,
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
		if (rows[0]) {
			return {
				operation: this.operationFromRow(rows[0]),
				created: true,
				conflict: false,
			};
		}
		const concurrent = await this.getOperationByIdempotency(
			row.principalId,
			row.kind,
			row.idempotencyKey,
		);
		if (!concurrent) throw new Error("operation insert conflict without an existing row");
		return {
			operation: concurrent,
			created: false,
			conflict: concurrent.requestDigest !== row.requestDigest,
		};
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

	private async appendHistoryTx(
		tx: SQL,
		row: WorkspaceRow,
		from: WorkspaceState | null,
		to: WorkspaceState,
		reason: ReasonCode | null,
		at: Date,
	): Promise<void> {
		await tx.unsafe(
			`INSERT INTO ${this.t("workspace_state_history")}
				(id, workspace_id, from_state, to_state, reason_code, occurred_at)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[randomUUID(), row.id, from, to, reason, at],
		);
	}

	private async appendEventTx(tx: SQL, row: WorkspaceRow, at: Date): Promise<void> {
		const payload = buildEventEnvelope(row, at);
		await tx.unsafe(
			`INSERT INTO ${this.t("event_outbox")}
				(id, workspace_id, event_type, payload, occurred_at, next_attempt_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
			[payload.id, row.id, payload.type, JSON.stringify(payload), at],
		);
	}

	// --- Logs ---

	async appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void> {
		if (entries.length === 0) return;
		await this.sql.begin(async (tx) => {
			// Serializes concurrent appends for one workspace so MAX(seq)+1
			// cannot collide (e.g. writes from an old and new connection).
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7080))", [workspaceId]);
			const stats = (await tx.unsafe(
				`SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq,
						COALESCE(SUM(length(content)), 0)::bigint AS bytes
				 FROM ${this.t("workspace_logs")} WHERE workspace_id = $1`,
				[workspaceId],
			)) as Array<{ max_seq: string | number; bytes: string | number }>;
			let seq = Number(stats[0]?.max_seq ?? 0);
			let bytes = Number(stats[0]?.bytes ?? 0);
			for (const entry of entries) {
				if (bytes + entry.content.length > MAX_LOG_BYTES) break;
				seq += 1;
				bytes += entry.content.length;
				await tx.unsafe(
					`INSERT INTO ${this.t("workspace_logs")}
						(workspace_id, seq, stream, occurred_at, content)
					 VALUES ($1, $2, $3, $4, $5)`,
					[workspaceId, seq, entry.stream, entry.occurredAt, entry.content],
				);
			}
		});
	}

	async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_logs")}
			 WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
			[workspaceId, afterSeq, limit],
		)) as Row[];
		return rows.map((r) => ({
			workspaceId: String(r.workspace_id),
			seq: Number(r.seq),
			stream: r.stream as LogRow["stream"],
			occurredAt: asDate(r.occurred_at),
			content: asBytes(r.content) ?? new Uint8Array(),
		}));
	}

	async readLogTail(
		workspaceId: string,
		maxBytes: number,
	): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }> {
		const stats = (await this.sql.unsafe(
			`SELECT COALESCE(SUM(length(content)), 0)::bigint AS bytes,
					MAX(seq)::bigint AS last_seq
			 FROM ${this.t("workspace_logs")} WHERE workspace_id = $1`,
			[workspaceId],
		)) as Array<{ bytes: string | number; last_seq: string | number | null }>;
		const totalBytes = Number(stats[0]?.bytes ?? 0);
		const lastSeq = stats[0]?.last_seq == null ? null : Number(stats[0].last_seq);
		if (totalBytes === 0) {
			return { content: new Uint8Array(), truncated: false, lastSeq };
		}
		const rows = (await this.sql.unsafe(
			`SELECT seq, content
			 FROM (
				SELECT seq, content,
					SUM(length(content)) OVER (ORDER BY seq DESC) AS cumulative_bytes
				FROM ${this.t("workspace_logs")}
				WHERE workspace_id = $1
			 ) tail
			 WHERE cumulative_bytes - length(content) < $2
			 ORDER BY seq ASC`,
			[workspaceId, maxBytes],
		)) as Row[];
		const combined = Buffer.concat(
			rows.map((row) => Buffer.from(asBytes(row.content) ?? new Uint8Array())),
		);
		const content = combined.byteLength > maxBytes ? combined.subarray(-maxBytes) : combined;
		return {
			content: Uint8Array.from(content),
			truncated: totalBytes > maxBytes,
			lastSeq,
		};
	}

	// --- Durable conversation history ---

	private conversationMessageFromRow(row: Row): ConversationMessageRow {
		return {
			workspaceId: String(row.workspace_id),
			seq: Number(row.seq),
			messageId: String(row.message_id),
			role: row.role as ConversationMessageRow["role"],
			content: String(row.content),
			occurredAt: asDate(row.occurred_at),
			metadata: asJson<Record<string, string>>(row.metadata),
			createdAt: asDate(row.created_at),
		};
	}

	async appendConversationMessage(
		input: Omit<ConversationMessageRow, "seq">,
	): Promise<{ message: ConversationMessageRow; created: boolean }> {
		return await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7081))", [
				input.workspaceId,
			]);
			const states = (await tx.unsafe(
				`SELECT status FROM ${this.t("workspace_conversations")} WHERE workspace_id = $1 FOR UPDATE`,
				[input.workspaceId],
			)) as Row[];
			if (states[0]?.status === "deleted") throw new Error("conversation.deleted");
			const existing = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspace_conversation_messages")}
				 WHERE workspace_id = $1 AND message_id = $2`,
				[input.workspaceId, input.messageId],
			)) as Row[];
			if (existing[0]) {
				return { message: this.conversationMessageFromRow(existing[0]), created: false };
			}
			await tx.unsafe(
				`INSERT INTO ${this.t("workspace_conversations")}
				 (workspace_id, status, expires_at, deleted_at, updated_at)
				 VALUES ($1, 'retained', NULL, NULL, $2)
				 ON CONFLICT (workspace_id) DO NOTHING`,
				[input.workspaceId, input.createdAt],
			);
			const stats = (await tx.unsafe(
				`SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq,
				        COUNT(*)::bigint AS message_count,
				        COALESCE(SUM(octet_length(content) + octet_length(metadata::text)), 0)::bigint AS bytes
				 FROM ${this.t("workspace_conversation_messages")} WHERE workspace_id = $1`,
				[input.workspaceId],
			)) as Array<{
				max_seq: string | number;
				message_count: string | number;
				bytes: string | number;
			}>;
			const inputBytes =
				Buffer.byteLength(input.content) + Buffer.byteLength(JSON.stringify(input.metadata));
			if (
				Number(stats[0]?.message_count ?? 0) >= MAX_CONVERSATION_MESSAGES ||
				Number(stats[0]?.bytes ?? 0) + inputBytes > MAX_CONVERSATION_BYTES
			) {
				throw new Error("conversation.quota_exceeded");
			}
			const seq = Number(stats[0]?.max_seq ?? 0) + 1;
			const inserted = (await tx.unsafe(
				`INSERT INTO ${this.t("workspace_conversation_messages")}
				 (workspace_id, seq, message_id, role, content, occurred_at, metadata, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
				[
					input.workspaceId,
					seq,
					input.messageId,
					input.role,
					input.content,
					input.occurredAt,
					JSON.stringify(input.metadata),
					input.createdAt,
				],
			)) as Row[];
			return { message: this.conversationMessageFromRow(inserted[0] as Row), created: true };
		});
	}

	async readConversation(
		workspaceId: string,
		afterSeq: number,
		limit: number,
	): Promise<ConversationMessageRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_conversation_messages")}
			 WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
			[workspaceId, afterSeq, limit],
		)) as Row[];
		return rows.map((row) => this.conversationMessageFromRow(row));
	}

	async getConversationState(workspaceId: string): Promise<ConversationStateRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_conversations")} WHERE workspace_id = $1`,
			[workspaceId],
		)) as Row[];
		const row = rows[0];
		return row
			? {
					workspaceId: String(row.workspace_id),
					status: row.status as ConversationStateRow["status"],
					expiresAt: asDateOrNull(row.expires_at),
					deletedAt: asDateOrNull(row.deleted_at),
					updatedAt: asDate(row.updated_at),
				}
			: null;
	}

	async setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void> {
		await this.sql.unsafe(
			`INSERT INTO ${this.t("workspace_conversations")}
			 (workspace_id, status, expires_at, deleted_at, updated_at)
			 VALUES ($1, 'retained', $2, NULL, $3)
			 ON CONFLICT (workspace_id) DO UPDATE
			 SET expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
			 WHERE ${this.t("workspace_conversations")}.status <> 'deleted'`,
			[workspaceId, expiresAt, at],
		);
	}

	async deleteConversation(workspaceId: string, at: Date): Promise<void> {
		await this.sql.begin(async (tx) => {
			await tx.unsafe(
				`DELETE FROM ${this.t("workspace_conversation_messages")} WHERE workspace_id = $1`,
				[workspaceId],
			);
			await tx.unsafe(
				`INSERT INTO ${this.t("workspace_conversations")}
				 (workspace_id, status, expires_at, deleted_at, updated_at)
				 VALUES ($1, 'deleted', NULL, $2, $2)
				 ON CONFLICT (workspace_id) DO UPDATE
				 SET status = 'deleted', expires_at = NULL, deleted_at = EXCLUDED.deleted_at,
				     updated_at = EXCLUDED.updated_at`,
				[workspaceId, at],
			);
		});
	}

	async pruneExpiredConversations(at: Date): Promise<number> {
		const rows = (await this.sql.unsafe(
			`DELETE FROM ${this.t("workspace_conversation_messages")} AS messages
			 USING ${this.t("workspace_conversations")} AS conversations
			 WHERE messages.workspace_id = conversations.workspace_id
			   AND conversations.status = 'retained'
			   AND conversations.expires_at IS NOT NULL
			   AND conversations.expires_at <= $1
			 RETURNING messages.workspace_id`,
			[at],
		)) as Row[];
		return new Set(rows.map((row) => String(row.workspace_id))).size;
	}

	// --- Outbox ---

	private outboxFromRow(r: Row): OutboxRow {
		return {
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			eventType: String(r.event_type),
			payload: asJson(r.payload),
			occurredAt: asDate(r.occurred_at),
			nextAttemptAt: asDate(r.next_attempt_at),
			attemptCount: Number(r.attempt_count),
			deliveredAt: asDateOrNull(r.delivered_at),
			lastErrorCode: (r.last_error_code as string | null) ?? null,
		};
	}

	async claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]> {
		// The claim pushes next_attempt_at forward as a lease so a crashed
		// dispatcher retries automatically.
		const rows = (await this.sql.unsafe(
			`UPDATE ${this.t("event_outbox")} o
			 SET next_attempt_at = $1::timestamptz + interval '${CLAIM_LEASE_MS} milliseconds'
			 WHERE o.id IN (
				SELECT id FROM ${this.t("event_outbox")}
				WHERE delivered_at IS NULL AND next_attempt_at <= $1
				ORDER BY occurred_at ASC LIMIT $2
				FOR UPDATE SKIP LOCKED
			 )
			 RETURNING *`,
			[now, limit],
		)) as Row[];
		return rows
			.map((r) => this.outboxFromRow(r))
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
	}

	async markEventDelivered(id: string, at: Date): Promise<void> {
		await this.sql.unsafe(
			`UPDATE ${this.t("event_outbox")}
			 SET delivered_at = $2, attempt_count = attempt_count + 1 WHERE id = $1`,
			[id, at],
		);
	}

	async markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
		await this.sql.unsafe(
			`UPDATE ${this.t("event_outbox")}
			 SET attempt_count = attempt_count + 1, last_error_code = $2, next_attempt_at = $3
			 WHERE id = $1`,
			[id, errorCode, nextAttemptAt],
		);
	}

	async appendEvent(
		workspaceId: string,
		eventType: string,
		payload: unknown,
		at: Date,
	): Promise<void> {
		await this.sql.unsafe(
			`INSERT INTO ${this.t("event_outbox")}
				(id, workspace_id, event_type, payload, occurred_at, next_attempt_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
			[randomUUID(), workspaceId, eventType, JSON.stringify(payload), at],
		);
	}
}
