import type {
	ConversationMessageRow,
	ConversationStateRow,
} from "@pstdio/pocketcoder-runtime-core";

import {
	asDate,
	asDateOrNull,
	asJson,
	MAX_CONVERSATION_BYTES,
	MAX_CONVERSATION_MESSAGES,
	type Row,
} from "./store-base";
import { PostgresLogStore } from "./store-logs";

export class PostgresConversationStore extends PostgresLogStore {
	protected conversationMessageFromRow(row: Row): ConversationMessageRow {
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
}
