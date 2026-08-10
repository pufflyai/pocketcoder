import type { NetworkEventInput } from "@pstdio/pocketcoder-contracts";
import type { LogRow, NetworkEventRow } from "@pstdio/pocketcoder-runtime-core";

import { asBytes, asDate, MAX_LOG_BYTES, type Row } from "./base";
import { OutputCommands } from "./outputs";

export class LogCommands extends OutputCommands {
  async appendLogs(
    workspaceId: string,
    entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.sql.begin(async (tx) => {
      // Serializes concurrent appends for one workspace so MAX(seq)+1
      // cannot collide (e.g. writes from an old and new connection).
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7080))", [workspaceId]);
      const stats = (await tx.unsafe(
        `SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq,
            COALESCE(SUM(length(content)), 0)::bigint AS bytes
         FROM ${this.t("workspace_logs")} WHERE workspace_id = $1`,
        [workspaceId],
      )) as Array<{ max_seq: string | number; bytes: string | number }>;
      let seq = Number(stats[0]?.max_seq ?? 0);
      let bytes = Number(stats[0]?.bytes ?? 0);
      for (const entry of entries) {
        if (bytes + entry.content.length > MAX_LOG_BYTES) break;
        seq += 1;
        bytes += entry.content.length;
        await tx.unsafe(
          `INSERT INTO ${this.t("workspace_logs")}
            (workspace_id, seq, stream, occurred_at, content)
           VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, seq, entry.stream, entry.occurredAt, entry.content],
        );
      }
    });
  }

  async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
    const rows = (await this.sql.unsafe(
      `SELECT * FROM ${this.t("workspace_logs")}
       WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [workspaceId, afterSeq, limit],
    )) as Row[];
    return rows.map((r) => ({
      workspaceId: String(r.workspace_id),
      seq: Number(r.seq),
      stream: r.stream as LogRow["stream"],
      occurredAt: asDate(r.occurred_at),
      content: asBytes(r.content) ?? new Uint8Array(),
    }));
  }

  async readLogTail(
    workspaceId: string,
    maxBytes: number,
  ): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }> {
    const stats = (await this.sql.unsafe(
      `SELECT COALESCE(SUM(length(content)), 0)::bigint AS bytes,
          MAX(seq)::bigint AS last_seq
       FROM ${this.t("workspace_logs")} WHERE workspace_id = $1`,
      [workspaceId],
    )) as Array<{ bytes: string | number; last_seq: string | number | null }>;
    const totalBytes = Number(stats[0]?.bytes ?? 0);
    const lastSeq = stats[0]?.last_seq == null ? null : Number(stats[0].last_seq);
    if (totalBytes === 0) {
      return { content: new Uint8Array(), truncated: false, lastSeq };
    }
    const rows = (await this.sql.unsafe(
      `SELECT seq, content
       FROM (
        SELECT seq, content,
          SUM(length(content)) OVER (ORDER BY seq DESC) AS cumulative_bytes
        FROM ${this.t("workspace_logs")}
        WHERE workspace_id = $1
       ) tail
       WHERE cumulative_bytes - length(content) < $2
       ORDER BY seq ASC`,
      [workspaceId, maxBytes],
    )) as Row[];
    const combined = Buffer.concat(
      rows.map((row) => Buffer.from(asBytes(row.content) ?? new Uint8Array())),
    );
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
    events: NetworkEventInput[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 7348))", [workspaceId]);
      for (const event of events) {
        const duplicate = (await tx.unsafe(
          `SELECT 1 FROM ${this.t("workspace_network_events")}
           WHERE workspace_id = $1 AND source_session_id = $2 AND source_seq = $3`,
          [workspaceId, sourceSessionId, event.source_seq],
        )) as Row[];
        if (duplicate.length > 0) continue;
        const updated = (await tx.unsafe(
          `UPDATE ${this.t("workspaces")} SET network_event_seq = network_event_seq + 1
           WHERE id = $1 RETURNING network_event_seq`,
          [workspaceId],
        )) as Row[];
        if (!updated[0]) throw new Error("workspace.not_found");
        await tx.unsafe(
          `INSERT INTO ${this.t("workspace_network_events")}
           (workspace_id, seq, source_session_id, source_seq, occurred_at, decision,
            transport, host, port, method, path, matched_rule, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            workspaceId,
            Number(updated[0].network_event_seq),
            sourceSessionId,
            event.source_seq,
            event.occurred_at,
            event.decision,
            event.transport,
            event.host,
            event.port,
            event.method,
            event.path,
            event.matched_rule,
            event.reason,
          ],
        );
      }
    });
  }

  async readNetworkEvents(
    workspaceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<NetworkEventRow[]> {
    const rows = (await this.sql.unsafe(
      `SELECT * FROM ${this.t("workspace_network_events")}
       WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [workspaceId, afterSeq, limit],
    )) as Row[];
    return rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      seq: Number(row.seq),
      sourceSessionId: String(row.source_session_id),
      source_seq: Number(row.source_seq),
      occurred_at: asDate(row.occurred_at).toISOString(),
      decision: row.decision as NetworkEventRow["decision"],
      transport: row.transport as NetworkEventRow["transport"],
      host: String(row.host),
      port: Number(row.port),
      method: (row.method as string | null) ?? null,
      path: (row.path as string | null) ?? null,
      matched_rule: (row.matched_rule as string | null) ?? null,
      reason: String(row.reason),
    }));
  }
}
