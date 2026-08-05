import type {
	TerminalSessionClose,
	TerminalSessionOpen,
	TerminalSessionRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryConversationStore } from "./memory-store-conversations";

function clone(row: TerminalSessionRow): TerminalSessionRow {
	return {
		...row,
		openedAt: new Date(row.openedAt),
		closedAt: row.closedAt ? new Date(row.closedAt) : null,
	};
}

export class MemoryTerminalStore extends MemoryConversationStore {
	async openTerminalSession(
		input: TerminalSessionOpen,
		maxOpenSessions: number,
	): Promise<TerminalSessionRow | null> {
		if (!this.workspaces.has(input.workspaceId))
			throw new Error("terminal workspace does not exist");
		const openCount = [...this.terminalSessions.values()].filter(
			(row) => row.workspaceId === input.workspaceId && row.closedAt === null,
		).length;
		if (openCount >= maxOpenSessions) return null;
		const row: TerminalSessionRow = {
			...input,
			closedAt: null,
			closeReason: null,
			exitCode: null,
			bytesIn: 0,
			bytesOut: 0,
		};
		this.terminalSessions.set(row.sessionId, row);
		return clone(row);
	}

	async getTerminalSession(sessionId: string): Promise<TerminalSessionRow | null> {
		const row = this.terminalSessions.get(sessionId);
		return row ? clone(row) : null;
	}

	async closeTerminalSession(
		sessionId: string,
		close: TerminalSessionClose,
	): Promise<TerminalSessionRow | null> {
		const row = this.terminalSessions.get(sessionId);
		if (!row || row.closedAt) return null;
		Object.assign(row, close);
		return clone(row);
	}

	async listTerminalSessions(workspaceId: string, cursor: string | undefined, limit: number) {
		const rows = [...this.terminalSessions.values()]
			.filter((row) => row.workspaceId === workspaceId)
			.sort(
				(a, b) =>
					b.openedAt.getTime() - a.openedAt.getTime() || b.sessionId.localeCompare(a.sessionId),
			);
		const start = cursor ? Math.max(0, rows.findIndex((row) => row.sessionId === cursor) + 1) : 0;
		return rows.slice(start, start + limit).map(clone);
	}
}
