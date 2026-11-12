import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { readInput } from "../persistence/inputs/objects";
import { inputIsPinned } from "../persistence/inputs/pins";

export async function pinSessionInputs(
  context: DatabaseContext,
  tx: Transaction,
  id: ManagedSessionIdentity,
  references: string[],
  at: Date,
  accepted = false,
) {
  const selected = [];
  const table = context.tables.sessionInputs;
  if (new Set(references).size !== references.length)
    throw new ApiError("attachment.invalid", "Duplicate inputs are not allowed.");
  for (const reference of references) {
    const [row] = await tx
      .select()
      .from(table)
      .where(
        and(eq(table.principalId, id.principalId), eq(table.sessionId, id.sessionId), eq(table.inputId, reference)),
      );
    const input = row && (await readInput(context, tx, row.source.workspaceId, row.inputId));
    if (
      !row ||
      input?.state !== "ready" ||
      (input.retainedUntil <= at &&
        !(accepted && (await inputIsPinned(context, tx, row.source.workspaceId, row.inputId))))
    )
      throw new ApiError("attachment.not_found", "Input is not ready or has expired.");
    selected.push(row.source);
  }
  return selected;
}
