import {
	WARM_POOL_RUNTIME_STATES,
	type WarmPoolClaim,
	type WarmPoolRuntimePatch,
	type WarmPoolRuntimeRow,
	type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";

import { asBytes, asDate, asDateOrNull, asJson, enumValue, type Row } from "./store-base";
import { PostgresTransitionStore } from "./store-transitions";

export class PostgresWarmPoolStore extends PostgresTransitionStore {
	protected warmPoolRuntimeFromRow(r: Row): WarmPoolRuntimeRow {
		return {
			id: String(r.id),
			templateId: String(r.template_id),
			templateName: String(r.template_name),
			templateVersion: String(r.template_version),
			templateDigest: String(r.template_digest),
			driverKind: String(r.driver_kind),
			eligibilityFingerprint: String(r.eligibility_fingerprint),
			state: enumValue(r.state, WARM_POOL_RUNTIME_STATES, "warm pool state"),
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
}
