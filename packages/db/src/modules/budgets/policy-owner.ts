import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import { desc, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { storedPolicy } from "../managed/stored-records";
import { nextPolicy, replayPolicy } from "./policy-revisions";

export function policyOwner(context: DatabaseContext) {
  const { db, tables } = context;
  const { budgetPolicies: policies } = tables;
  const auth = authorityContext(context);
  async function latest(tx: Transaction, scopeId: string) {
    const [row] = await tx
      .select()
      .from(policies)
      .where(eq(policies.scopeId, scopeId))
      .orderBy(desc(policies.revision))
      .limit(1);
    if (!row) throw new ApiError("budget.not_found", "A required budget policy is missing.");
    return storedPolicy(row.policy);
  }
  return {
    latest,
    async writePolicy(keyId: string, input: managed.BudgetPolicyWrite, expectedRevision: number | null) {
      const parsed = managed.BudgetPolicyWriteSchema.parse(input);
      return db.transaction(async (tx) => {
        await auth.scope(tx, keyId, input.scopeId, true);
        const known = await tx
          .select()
          .from(policies)
          .where(eq(policies.scopeId, input.scopeId))
          .orderBy(desc(policies.revision));
        const prior = known.find((row) => row.revision === parsed.revision);
        if (prior) return replayPolicy(storedPolicy(prior.policy), parsed, expectedRevision);
        const previous = known[0] && storedPolicy(known[0].policy);
        nextPolicy(previous, parsed, expectedRevision);
        if (previous && previous.period !== parsed.period) {
          const capacity = (await tx.select().from(context.tables.managedCapacity)).some(
            (row) => row.record.scopeIds.includes(input.scopeId) && row.record.starts.some((start) => start.submitted),
          );
          if (capacity)
            throw new ApiError("budget.conflict", "Changing a period with recorded starts requires audited handover.");
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
