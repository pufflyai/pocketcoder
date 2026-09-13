import type { LogRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, lt, max, sql } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { requiredRow } from "../../database/required-row";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
export function createLogs({ db, tables: { workspaceLogs: logs } }: DatabaseContext) {
  return {
    async appendLogs(workspaceId: string, entries: Array<Pick<LogRow, "stream" | "occurredAt" | "content">>) {
      if (entries.length === 0) return;
      await db.transaction(async (tx) => {
        await lock(tx, workspaceId, 7080);
        const [stats] = await tx
          .select({
            maxSeq: sql`coalesce(max(${logs.seq}),0)`.mapWith(Number),
            bytes: sql`coalesce(sum(length(${logs.content})),0)`.mapWith(Number),
          })
          .from(logs)
          .where(eq(logs.workspaceId, workspaceId));
        let seq = requiredRow(stats).maxSeq;
        let bytes = requiredRow(stats).bytes;
        for (const entry of entries) {
          if (bytes + entry.content.length > MAX_LOG_BYTES) break;
          seq += 1;
          bytes += entry.content.length;
          await tx.insert(logs).values({ ...entry, workspaceId, seq });
        }
      });
    },
    async readLogs(workspaceId: string, afterSeq: number, limit: number) {
      return db
        .select()
        .from(logs)
        .where(and(eq(logs.workspaceId, workspaceId), gt(logs.seq, afterSeq)))
        .orderBy(asc(logs.seq))
        .limit(limit);
    },
    async readLogTail(workspaceId: string, maxBytes: number) {
      const [stats] = await db
        .select({ bytes: sql`coalesce(sum(length(${logs.content})),0)`.mapWith(Number), lastSeq: max(logs.seq) })
        .from(logs)
        .where(eq(logs.workspaceId, workspaceId));
      const totalBytes = requiredRow(stats).bytes;
      const lastSeq = requiredRow(stats).lastSeq;
      if (totalBytes === 0) return { content: new Uint8Array(), truncated: false, lastSeq };
      const tail = db
        .select({
          seq: logs.seq,
          content: logs.content,
          cumulativeBytes: sql`sum(length(${logs.content})) over (order by ${logs.seq} desc)`
            .mapWith(Number)
            .as("cumulative_bytes"),
        })
        .from(logs)
        .where(eq(logs.workspaceId, workspaceId))
        .as("tail");
      const rows = await db
        .select({ content: tail.content })
        .from(tail)
        .where(lt(sql`${tail.cumulativeBytes}-length(${tail.content})`, maxBytes))
        .orderBy(asc(tail.seq));
      const combined = Buffer.concat(rows.map((row) => Buffer.from(row.content)));
      const content = combined.byteLength > maxBytes ? combined.subarray(-maxBytes) : combined;
      return { content: Uint8Array.from(content), truncated: totalBytes > maxBytes, lastSeq };
    },
  };
}
