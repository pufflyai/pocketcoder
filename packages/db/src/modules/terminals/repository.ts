import type { TerminalSessionClose, TerminalSessionOpen } from "@pstdio/pocketcoder-runtime-contracts";
import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createTerminals({ db, tables: { workspaceTerminalSessions: sessions } }: DatabaseContext) {
  return {
    async openTerminalSession(input: TerminalSessionOpen, maxOpenSessions: number) {
      return db.transaction(async (tx) => {
        await lock(tx, input.workspaceId, 9187);
        const [current] = await tx
          .select({ n: count() })
          .from(sessions)
          .where(and(eq(sessions.workspaceId, input.workspaceId), isNull(sessions.closedAt)));
        if (requiredRow(current).n >= maxOpenSessions) return null;
        const [row] = await tx.insert(sessions).values(input).returning();
        return requiredRow(row);
      });
    },
    async getTerminalSession(sessionId: string) {
      const [row] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));
      return row ?? null;
    },
    async closeTerminalSession(sessionId: string, close: TerminalSessionClose) {
      const [row] = await db
        .update(sessions)
        .set(close)
        .where(and(eq(sessions.sessionId, sessionId), isNull(sessions.closedAt)))
        .returning();
      return row ?? null;
    },
    async listTerminalSessions(workspaceId: string, cursor: string | undefined, limit: number) {
      let cursorFilter: SQL | undefined;
      if (cursor) {
        const cursorQuery = db
          .select({ openedAt: sessions.openedAt, sessionId: sessions.sessionId })
          .from(sessions)
          .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.sessionId, cursor)));
        cursorFilter = sql`(${sessions.openedAt}, ${sessions.sessionId}) < (${cursorQuery})`;
      }
      return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.workspaceId, workspaceId), cursorFilter))
        .orderBy(desc(sessions.openedAt), desc(sessions.sessionId))
        .limit(limit);
    },
  };
}
