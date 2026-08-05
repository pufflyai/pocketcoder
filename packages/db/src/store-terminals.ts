import { TERMINAL_CLOSE_REASONS } from "@pstdio/pocketcoder-contracts";
import type {
	TerminalSessionClose,
	TerminalSessionOpen,
	TerminalSessionRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { asDate, asDateOrNull, enumValue, type Row } from "./store-base";
import { PostgresConversationStore } from "./store-conversations";

export class PostgresTerminalStore extends PostgresConversationStore {
	async openTerminalSession(
		input: TerminalSessionOpen,
		maxOpenSessions: number,
	): Promise<TerminalSessionRow | null> {
		return await this.sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 9187))", [
				input.workspaceId,
			]);
			const count = (await tx.unsafe(
				`SELECT count(*)::int AS count FROM ${this.t("workspace_terminal_sessions")}
				 WHERE workspace_id = $1 AND closed_at IS NULL`,
				[input.workspaceId],
			)) as Row[];
			if (Number(count[0]?.count ?? 0) >= maxOpenSessions) return null;
			const rows = (await tx.unsafe(
				`INSERT INTO ${this.t("workspace_terminal_sessions")}
					(session_id, workspace_id, key_id, opened_at, bytes_in, bytes_out)
				 VALUES ($1, $2, $3, $4, 0, 0) RETURNING *`,
				[input.sessionId, input.workspaceId, input.keyId, input.openedAt],
			)) as Row[];
			return this.terminalFromRow(rows[0] as Row);
		});
	}

	async getTerminalSession(sessionId: string): Promise<TerminalSessionRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_terminal_sessions")} WHERE session_id = $1`,
			[sessionId],
		)) as Row[];
		return rows[0] ? this.terminalFromRow(rows[0]) : null;
	}

	async closeTerminalSession(
		sessionId: string,
		close: TerminalSessionClose,
	): Promise<TerminalSessionRow | null> {
		const rows = (await this.sql.unsafe(
			`UPDATE ${this.t("workspace_terminal_sessions")}
			 SET closed_at = $2, close_reason = $3, exit_code = $4, bytes_in = $5, bytes_out = $6
			 WHERE session_id = $1 AND closed_at IS NULL RETURNING *`,
			[sessionId, close.closedAt, close.closeReason, close.exitCode, close.bytesIn, close.bytesOut],
		)) as Row[];
		return rows[0] ? this.terminalFromRow(rows[0]) : null;
	}

	async listTerminalSessions(workspaceId: string, cursor: string | undefined, limit: number) {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_terminal_sessions")}
			 WHERE workspace_id = $1
			   AND ($2::uuid IS NULL OR (opened_at, session_id) < (
				 SELECT opened_at, session_id FROM ${this.t("workspace_terminal_sessions")}
				 WHERE workspace_id = $1 AND session_id = $2::uuid
			   ))
			 ORDER BY opened_at DESC, session_id DESC LIMIT $3`,
			[workspaceId, cursor ?? null, limit],
		)) as Row[];
		return rows.map((row) => this.terminalFromRow(row));
	}

	private terminalFromRow(row: Row): TerminalSessionRow {
		return {
			sessionId: String(row.session_id),
			workspaceId: String(row.workspace_id),
			keyId: String(row.key_id),
			openedAt: asDate(row.opened_at),
			closedAt: asDateOrNull(row.closed_at),
			closeReason:
				row.close_reason === null
					? null
					: enumValue(row.close_reason, TERMINAL_CLOSE_REASONS, "terminal close reason"),
			exitCode: row.exit_code === null ? null : Number(row.exit_code),
			bytesIn: Number(row.bytes_in),
			bytesOut: Number(row.bytes_out),
		};
	}
}
