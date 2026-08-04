import { randomUUID } from "node:crypto";
import { TemplateSpecSchema } from "@pstdio/pocketcoder-contracts";
import {
	TEMPLATE_STATUSES,
	type TemplateRow,
	type TemplateStatus,
	type TemplateUpsert,
	type UpsertResult,
} from "@pstdio/pocketcoder-runtime-core";

import {
	asDate,
	asDateOrNull,
	asJson,
	enumValue,
	PostgresStoreBase,
	pgTextArray,
	type Row,
} from "./store-base";

export class PostgresTemplateStore extends PostgresStoreBase {
	protected templateFromRow(r: Row): TemplateRow {
		return {
			id: String(r.id),
			name: String(r.name),
			version: String(r.version),
			digest: String(r.digest),
			description: (r.description as string | null) ?? null,
			spec: TemplateSpecSchema.parse(asJson(r.spec)),
			status: enumValue(r.status, TEMPLATE_STATUSES, "template status"),
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
}
