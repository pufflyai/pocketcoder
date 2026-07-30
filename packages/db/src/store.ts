import { randomUUID } from "node:crypto";
import {
	canTransition,
	isTerminal,
	type ReasonCode,
	type TemplateSnapshot,
	type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import {
	type ActiveCounts,
	buildEventEnvelope,
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
	type WorkspaceInsert,
	type WorkspaceListFilter,
	type WorkspacePatch,
	type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import { migrate } from "./migrate";
import { assertValidSchema } from "./schema";

// PostgreSQL implementation of the Store contract. All identifiers are
// qualified with the configured schema; the runtime never reads or writes
// another schema.

const MAX_LOG_BYTES = 10 * 1024 * 1024;
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

export class PostgresStore implements Store {
	private readonly sql: SQL;
	private readonly schema: string;

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
		await this.sql.end();
	}

	// --- Templates ---

	private templateFromRow(r: Row): TemplateRow {
		return {
			id: String(r.id),
			name: String(r.name),
			version: String(r.version),
			digest: String(r.digest),
			description: (r.description as string | null) ?? null,
			spec: asJson(r.spec),
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
			templateSnapshot: asJson<TemplateSnapshot>(r.template_snapshot),
			state: r.state as WorkspaceState,
			reasonCode: (r.reason_code as ReasonCode | null) ?? null,
			terminalIntent: (r.terminal_intent as WorkspaceState | null) ?? null,
			launchInput: r.launch_input == null ? null : asJson(r.launch_input),
			providerKind: (r.provider_kind as string | null) ?? null,
			providerRef: r.provider_ref == null ? null : asJson(r.provider_ref),
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
				   AND state NOT IN ('succeeded', 'failed', 'canceled', 'expired')`,
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
					 deadline_at, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'queued',
						 $11::jsonb, $12::jsonb, $13, $14, $14)
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
		if (filter.cursor) {
			params.push(filter.cursor);
			clauses.push(
				`created_at < (SELECT created_at FROM ${this.t("workspaces")} WHERE id = $${params.length})`,
			);
		}
		params.push(filter.limit);
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspaces")} WHERE ${clauses.join(" AND ")}
			 ORDER BY created_at DESC LIMIT $${params.length}`,
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
			 WHERE state NOT IN ('succeeded', 'failed', 'canceled', 'expired')`,
		)) as Row[];
		return rows.map((r) => this.workspaceFromRow(r));
	}

	async countActive(): Promise<ActiveCounts> {
		const rows = (await this.sql.unsafe(
			`SELECT principal_id, template_name, count(*)::int AS n
			 FROM ${this.t("workspaces")}
			 WHERE state IN ('provisioning', 'connected', 'ready', 'terminating')
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
	};

	private static readonly JSONB_PATCH_KEYS = new Set(["launchInput", "providerRef", "health"]);

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
		await this.sql.unsafe(
			`UPDATE ${this.t("workspaces")} SET updated_at = $2${sets.length ? `, ${sets.join(", ")}` : ""}
			 WHERE id = $1`,
			params,
		);
	}

	async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
		return await this.sql.begin(async (tx) => {
			const rows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")} WHERE id = $1 FOR UPDATE`,
				[id],
			)) as Row[];
			const current = rows[0] ? this.workspaceFromRow(rows[0] as Row) : null;
			if (!current) return null;
			if (!req.from.includes(current.state)) return null;
			if (!canTransition(current.state, req.to)) return null;

			const params: unknown[] = [id, req.to, req.at];
			const sets = [`state = $2`, `updated_at = $3`];
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
			return workspace;
		});
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
}
