import { randomUUID } from "node:crypto";
import type { OutboxRow } from "@pstdio/pocketcoder-runtime-core";

import { asDate, asDateOrNull, asJson, CLAIM_LEASE_MS, type Row } from "./store-base";
import { PostgresTerminalStore } from "./store-terminals";

export class PostgresOutboxStore extends PostgresTerminalStore {
	protected outboxFromRow(r: Row): OutboxRow {
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
