import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ConversationStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, or, type SQL, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

export function createExecutionReads({ db, tables: { conversationRequests: requests } }: DatabaseContext) {
  return {
    async listConversationExecutions(input: Parameters<ConversationStore["listConversationExecutions"]>[0]) {
      // The physical reference stays on the existing canonical request row.
      // A receipt may predate physical placement, so workspace_id is not its owner.
      const scope = and(
        eq(requests.principalId, input.principalId),
        eq(requests.conversationId, input.conversationId),
        eq(sql<string>`${requests.execution} #>> '{acceptance,execution,workspaceId}'`, input.workspaceId),
      );
      let after: SQL | undefined;
      if (input.cursor) {
        const [previous] = await db
          .select()
          .from(requests)
          .where(and(scope, eq(requests.requestId, input.cursor)));
        if (!previous) throw new ApiError("validation.invalid", "Unknown request cursor.");
        after = or(
          gt(requests.acceptedAt, previous.acceptedAt),
          and(eq(requests.acceptedAt, previous.acceptedAt), gt(requests.requestId, previous.requestId)),
        );
      }
      const rows = await db
        .select()
        .from(requests)
        .where(and(scope, after))
        .orderBy(asc(requests.acceptedAt), asc(requests.requestId))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        items: page.flatMap((row) => (row.execution ? [row.execution] : [])),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.requestId ?? null) : null,
      };
    },
  };
}
