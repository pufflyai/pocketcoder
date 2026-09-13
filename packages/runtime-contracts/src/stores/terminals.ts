import type { TerminalCloseReason } from "@pstdio/pocketcoder-contracts";

export interface TerminalSessionRow {
  sessionId: string;
  workspaceId: string;
  keyId: string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: TerminalCloseReason | null;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number;
}

export type TerminalSessionOpen = Pick<TerminalSessionRow, "sessionId" | "workspaceId" | "keyId" | "openedAt">;

export interface TerminalSessionClose {
  closedAt: Date;
  closeReason: TerminalCloseReason;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number;
}

export interface TerminalAuditStore {
  openTerminalSession(row: TerminalSessionOpen, maxOpenSessions: number): Promise<TerminalSessionRow | null>;
  getTerminalSession(sessionId: string): Promise<TerminalSessionRow | null>;
  closeTerminalSession(sessionId: string, close: TerminalSessionClose): Promise<TerminalSessionRow | null>;
  listTerminalSessions(workspaceId: string, cursor: string | undefined, limit: number): Promise<TerminalSessionRow[]>;
}
