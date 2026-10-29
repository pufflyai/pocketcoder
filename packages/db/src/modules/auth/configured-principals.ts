import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { PrincipalPatch, PrincipalRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import type { JournalEvent } from "../../journal/events";
import { revokeKeyIds, unrevokedKeyIds } from "./key-ids";
import { principalEvents } from "./principal-administration";

export interface ConfiguredPrincipal {
  id: string;
  name: string;
  scopes: string[];
  templateNames: string[];
  disabled: boolean;
}

function sameList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function principalPatch(target: PrincipalRow, input: ConfiguredPrincipal): PrincipalPatch {
  return {
    ...(sameList(target.scopes, input.scopes) ? {} : { scopes: input.scopes }),
    ...(sameList(target.templateNames, input.templateNames) ? {} : { templateNames: input.templateNames }),
    ...(input.disabled === (target.disabledAt !== null) ? {} : { disabled: input.disabled }),
  };
}

// The controller applies its principal file with its own authority, so no calling key is checked.
// Journal records follow the same narrowing rule as key-authorized principal updates.
export function createConfiguredPrincipals({ db, journal, tables }: DatabaseContext) {
  const { principals } = tables;

  async function create(tx: Transaction, input: ConfiguredPrincipal, at: Date) {
    const [created] = await tx
      .insert(principals)
      .values({
        id: input.id,
        name: input.name,
        scopes: input.scopes,
        templateNames: input.templateNames,
        createdAt: at,
        disabledAt: input.disabled ? at : null,
      })
      .onConflictDoNothing({ target: principals.name })
      .returning();
    if (!created) throw new ApiError("principal.name_conflict", "A principal with this name already exists.");
    return created;
  }

  async function update(tx: Transaction, target: PrincipalRow, input: ConfiguredPrincipal, at: Date) {
    const patch = principalPatch(target, input);
    const keyIds = await unrevokedKeyIds(tx, tables, input.id, patch.disabled === true);
    const events = principalEvents({ target, patch, ...input, keyIds, at });
    for (const event of events.now) journal?.append(event);
    const [updated] = await tx
      .update(principals)
      .set({
        scopes: input.scopes,
        templateNames: input.templateNames,
        ...(patch.disabled === undefined ? {} : { disabledAt: patch.disabled ? at : null }),
      })
      .where(eq(principals.id, input.id))
      .returning();
    await revokeKeyIds(tx, tables, keyIds, at);
    return { row: requiredRow(updated), later: events.later };
  }

  return {
    async applyConfiguredPrincipal(input: ConfiguredPrincipal) {
      const later: JournalEvent[] = [];
      const row = await db.transaction(async (tx) => {
        const at = new Date();
        const [target] = await tx.select().from(principals).where(eq(principals.id, input.id)).for("update");
        if (!target) return create(tx, input, at);
        const result = await update(tx, target, input, at);
        later.push(...result.later);
        return result.row;
      });
      // Granting records follow the commit, so a lost record leaves a restore narrower, not wider.
      for (const event of later) journal?.append(event);
      return row;
    },
  };
}
