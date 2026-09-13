import type { LogRow, Store } from "@pstdio/pocketcoder-runtime-contracts";
import { MAX_LOG_BYTES, type MemoryState } from "../../state/memory-store-base";

export class MemoryLogStore {
  constructor(private readonly context: Pick<MemoryState, "logs" | "logBytes" | "networkEvents" | "workspaces">) {}
  async appendLogs(
    workspaceId: string,
    entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
  ): Promise<void> {
    const list = this.context.logs.get(workspaceId) ?? [];
    let bytes = this.context.logBytes.get(workspaceId) ?? 0;
    let seq = list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
    for (const entry of entries) {
      if (bytes + entry.content.length > MAX_LOG_BYTES) {
        break;
      }
      seq += 1;
      bytes += entry.content.length;
      list.push({
        workspaceId,
        seq,
        stream: entry.stream,
        occurredAt: entry.occurredAt,
        content: entry.content,
      });
    }
    this.context.logs.set(workspaceId, list);
    this.context.logBytes.set(workspaceId, bytes);
  }

  async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
    return (this.context.logs.get(workspaceId) ?? [])
      .filter((l) => l.seq > afterSeq)
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }

  async readLogTail(
    workspaceId: string,
    maxBytes: number,
  ): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }> {
    const rows = this.context.logs.get(workspaceId) ?? [];
    const lastSeq = rows.at(-1)?.seq ?? null;
    const totalBytes = rows.reduce((sum, row) => sum + row.content.byteLength, 0);
    const combined = Buffer.concat(rows.map((row) => Buffer.from(row.content)));
    const content = combined.byteLength > maxBytes ? combined.subarray(-maxBytes) : combined;
    return {
      content: Uint8Array.from(content),
      truncated: totalBytes > maxBytes,
      lastSeq,
    };
  }

  async appendNetworkEvents(
    workspaceId: string,
    sourceSessionId: string,
    events: Parameters<Store["appendNetworkEvents"]>[2],
  ): Promise<void> {
    const rows = this.context.networkEvents.get(workspaceId) ?? [];
    const seen = new Set(rows.map((row) => `${row.sourceSessionId}:${row.source_seq}`));
    const workspace = this.context.workspaces.get(workspaceId);
    if (!workspace) throw new Error("workspace.not_found");
    for (const event of events) {
      const key = `${sourceSessionId}:${event.source_seq}`;
      if (seen.has(key)) continue;
      workspace.networkEventSeq += 1;
      rows.push({ ...event, workspaceId, sourceSessionId, seq: workspace.networkEventSeq });
      seen.add(key);
    }
    this.context.networkEvents.set(workspaceId, rows);
  }

  async readNetworkEvents(workspaceId: string, afterSeq: number, limit: number) {
    return (this.context.networkEvents.get(workspaceId) ?? [])
      .filter((row) => row.seq > afterSeq)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}
