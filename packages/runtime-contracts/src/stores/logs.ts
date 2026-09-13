export interface LogRow {
  workspaceId: string;
  seq: number;
  stream: "stdout" | "stderr" | "runtime";
  occurredAt: Date;
  content: Uint8Array;
}

export interface LogStore {
  appendLogs(
    workspaceId: string,
    entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
  ): Promise<void>;
  readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]>;
  readLogTail(
    workspaceId: string,
    maxBytes: number,
  ): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }>;
}
