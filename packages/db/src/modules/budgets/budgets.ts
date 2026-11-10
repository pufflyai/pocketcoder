import type { ManagedBudgetStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { capacityUsage, periodAt } from "./capacity-ledger";
import { policyOwner } from "./policy-owner";
import { lockScopes } from "./scope-locks";

// Budget scopes bound physical capacity only. Model usage belongs to the deployment's model gateway.
export function createManagedBudgets(context: DatabaseContext, now = () => new Date()): ManagedBudgetStore {
  const policies = policyOwner(context);
  const auth = authorityContext(context);
  return {
    ...policies,
    async usage(keyId, scopeId) {
      return context.db.transaction(async (tx) => {
        await auth.scope(tx, keyId, scopeId, false);
        const at = await lockScopes(context, tx, [scopeId], now());
        const policy = await policies.latest(tx, scopeId);
        const { workspaceStarts, activeWorkspaces } = await capacityUsage(context, tx, policy, at);
        const { start, end } = periodAt(at, policy.period);
        return {
          scopeId,
          policyRevision: policy.revision,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          workspaceStarts,
          activeWorkspaces,
          asOf: at.toISOString(),
        };
      });
    },
  };
}
