import { randomUUID } from "node:crypto";
import type { MachineKeyRow, PrincipalRow } from "@pstdio/pocketcoder-runtime-core";

import { asBytes, asDate, asDateOrNull, pgTextArray, type Row, textArray } from "./store-base";
import { PostgresTemplateStore } from "./store-templates";

export class PostgresAuthStore extends PostgresTemplateStore {
	protected principalFromRow(r: Row): PrincipalRow {
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
}
