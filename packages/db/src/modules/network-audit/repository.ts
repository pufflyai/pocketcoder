import type { NetworkEventInput } from "@pstdio/pocketcoder-contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { contentWritable } from "../persistence/content";

export function createNetworkAudit(context: DatabaseContext) {
  const {
    db,
    tables: { workspaceNetworkEvents: events, workspaces },
  } = context;
  return {
    async appendNetworkEvents(workspaceId: string, sourceSessionId: string, inputs: NetworkEventInput[]) {
      if (inputs.length === 0) return;
      await db.transaction(async (tx) => {
        if (!(await contentWritable(tx, context.tables, workspaceId))) return;
        await lock(tx, workspaceId, 7348);
        for (const event of inputs) {
          const [duplicate] = await tx
            .select({ seq: events.seq })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, workspaceId),
                eq(events.sourceSessionId, sourceSessionId),
                eq(events.sourceSeq, event.source_seq),
              ),
            );
          if (duplicate) continue;
          const [workspace] = await tx
            .update(workspaces)
            .set({ networkEventSeq: sql`${workspaces.networkEventSeq}+1` })
            .where(eq(workspaces.id, workspaceId))
            .returning({ seq: workspaces.networkEventSeq });
          if (!workspace) throw new Error("workspace.not_found");
          await tx.insert(events).values({
            workspaceId,
            seq: workspace.seq,
            sourceSessionId,
            sourceSeq: event.source_seq,
            occurredAt: new Date(event.occurred_at),
            decision: event.decision,
            transport: event.transport,
            host: event.host,
            port: event.port,
            method: event.method,
            path: event.path,
            matchedRule: event.matched_rule,
            reason: event.reason,
          });
        }
      });
    },
    async readNetworkEvents(workspaceId: string, afterSeq: number, limit: number) {
      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, workspaceId), gt(events.seq, afterSeq)))
        .orderBy(asc(events.seq))
        .limit(limit);
      return rows.map(({ sourceSeq, occurredAt, matchedRule, ...row }) => ({
        ...row,
        source_seq: sourceSeq,
        occurred_at: occurredAt.toISOString(),
        matched_rule: matchedRule,
      }));
    },
  };
}
