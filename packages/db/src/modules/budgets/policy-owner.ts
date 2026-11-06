import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import { desc, eq } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { nextPolicy, replayPolicy } from "./policy-revisions";

export function policyOwner(context: DatabaseContext) {
  const { db, tables } = context;
  const { budgetPolicies: policies, budgetInvocations: invocations } = tables;
  const auth = authorityContext(context);
  async function latest(tx: Transaction, scopeId: string) {
    const [row] = await tx
      .select()
      .from(policies)
      .where(eq(policies.scopeId, scopeId))
      .orderBy(desc(policies.revision))
      .limit(1);
    if (!row) throw new ApiError("budget.not_found", "A required budget policy is missing.");
    return row.policy;
  }
  return {
    latest,
    async writePolicy(keyId: string, input: managed.BudgetPolicyWrite, expectedRevision: number | null) {
      const parsed = managed.BudgetPolicyWriteSchema.parse(input);
      if (
        new Set(parsed.modelLimits.map((m) => m.model)).size !== parsed.modelLimits.length ||
        parsed.limits.defaultOutputTokens > parsed.limits.maxOutputTokensPerInvocation
      )
        throw new ApiError("validation.invalid", "Invalid model or output limits.");
      parsed.modelLimits.sort((a, b) => a.model.localeCompare(b.model));
      return db.transaction(async (tx) => {
        await auth.scope(tx, keyId, input.scopeId, true);
        await lock(tx, input.scopeId, 34);
        const known = await tx
          .select()
          .from(policies)
          .where(eq(policies.scopeId, input.scopeId))
          .orderBy(desc(policies.revision));
        const prior = known.find((row) => row.revision === parsed.revision);
        if (prior) return replayPolicy(prior.policy, parsed, expectedRevision);
        const previous = known[0]?.policy;
        nextPolicy(previous, parsed, expectedRevision);
        if (previous && previous.period !== parsed.period) {
          const exposure = (await tx.select().from(invocations)).some((row) =>
            row.record.reservation.scopeIds.includes(input.scopeId),
          );
          if (exposure)
            throw new ApiError("budget.conflict", "Changing a period with exposure requires audited handover.");
        }
        const policy = { ...parsed, effectiveAt: new Date().toISOString() };
        await tx.insert(policies).values({ scopeId: input.scopeId, revision: input.revision, policy });
        return policy;
      });
    },
    async readPolicy(keyId: string, scopeId: string) {
      return db.transaction(async (tx) => {
        await auth.scope(tx, keyId, scopeId, false);
        return latest(tx, scopeId);
      });
    },
  };
}
