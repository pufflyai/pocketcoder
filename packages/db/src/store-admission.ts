import type {
	ActiveCounts,
	WorkspaceAdmissionClaim,
	WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";

import type { Row } from "./store-base";
import { PostgresWorkspaceStore } from "./store-workspaces";

export class PostgresAdmissionStore extends PostgresWorkspaceStore {
	async listQueuedHeads(): Promise<WorkspaceRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM (
				 SELECT DISTINCT ON (principal_id) * FROM ${this.t("workspaces")}
				 WHERE state = 'queued'
				 ORDER BY principal_id, created_at ASC, id ASC
			 ) AS heads
			 ORDER BY created_at ASC, id ASC`,
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

	async claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null> {
		const workspace = await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7351))", [
				`${this.schema}:workspace-admission`,
			]);
			const rows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")} WHERE id = $1 FOR UPDATE`,
				[claim.workspaceId],
			)) as Row[];
			const current = rows[0] ? this.workspaceFromRow(rows[0]) : null;
			if (current?.state !== "queued") return null;

			const activeRows = (await tx.unsafe(
				`SELECT principal_id, template_name, count(*)::int AS n
				 FROM ${this.t("workspaces")}
				 WHERE state IN ('provisioning', 'connected', 'ready', 'preserving', 'terminating')
				 GROUP BY principal_id, template_name`,
			)) as Array<{ principal_id: string; template_name: string; n: number }>;
			const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
			for (const row of activeRows) {
				counts.global += row.n;
				counts.byPrincipal[row.principal_id] = (counts.byPrincipal[row.principal_id] ?? 0) + row.n;
				counts.byTemplate[row.template_name] = (counts.byTemplate[row.template_name] ?? 0) + row.n;
			}
			if (counts.global >= claim.limits.globalActiveWorkspaces) return null;
			if (
				(counts.byPrincipal[current.principalId] ?? 0) >= claim.limits.perPrincipalActiveWorkspaces
			) {
				return null;
			}
			const templateLimit =
				claim.limits.perTemplateActiveWorkspaces[current.templateName] ??
				claim.limits.globalActiveWorkspaces;
			if ((counts.byTemplate[current.templateName] ?? 0) >= templateLimit) return null;

			const updated = (await tx.unsafe(
				`UPDATE ${this.t("workspaces")}
				 SET state = 'provisioning', updated_at = $2, change_seq = change_seq + 1,
				     provisioning_mode = 'cold', registration_digest = $3,
				     registration_expires_at = $4, launch_attempts = launch_attempts + 1
				 WHERE id = $1 AND state = 'queued' RETURNING *`,
				[claim.workspaceId, claim.at, claim.registrationDigest, claim.registrationExpiresAt],
			)) as Row[];
			if (!updated[0]) return null;
			const claimed = this.workspaceFromRow(updated[0]);
			await this.appendHistoryTx(
				tx,
				claimed,
				"queued",
				"provisioning",
				claimed.reasonCode,
				claim.at,
			);
			await this.appendEventTx(tx, claimed, claim.at);
			return claimed;
		});
		if (workspace) this.notifyWorkspaceChange(workspace.id);
		return workspace;
	}

	protected static readonly PATCH_COLUMNS: Record<string, string> = {
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
		networkState: "network_state",
		failureLogTail: "failure_log_tail",
		failureLogTailTruncated: "failure_log_tail_truncated",
		failureLastLogSeq: "failure_last_log_seq",
		resolvedSource: "resolved_source",
		persistenceCapability: "persistence_capability",
		latestCheckpointId: "latest_checkpoint_id",
		outputs: "outputs",
	};

	protected static readonly JSONB_PATCH_KEYS = new Set([
		"launchInput",
		"providerRef",
		"health",
		"resolvedSource",
		"outputs",
	]);

	protected static readonly CHANGE_PATCH_KEYS = new Set([
		"connectedAt",
		"disconnectedAt",
		"health",
		"agentState",
		"networkState",
		"failureLogTail",
		"failureLogTailTruncated",
		"failureLastLogSeq",
		"resolvedSource",
		"persistenceCapability",
		"latestCheckpointId",
		"outputs",
	]);
}
