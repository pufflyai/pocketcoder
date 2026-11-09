import type { ManagedBudgetStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "../../database/context";
import { authorityContext } from "../managed/authority-context";
import { usageSnapshot } from "./accounting";
import { capacityUsage } from "./capacity-ledger";
import { invocationObserver } from "./invocations";
import { budgetLedger } from "./ledger";
import { policyOwner } from "./policy-owner";
import { reservationOwner } from "./reservations";
import { sendClaimOwner } from "./send-claim";
import { settlementOwner } from "./settlement";

export function createManagedBudgets(context: DatabaseContext, now = () => new Date()): ManagedBudgetStore {
  const policies = policyOwner(context);
  const ledger = budgetLedger(context, now);
  const auth = authorityContext(context);
  return {
    ...policies,
    ...reservationOwner(context, now),
    ...settlementOwner(context, now),
    ...sendClaimOwner(context, now),
    ...invocationObserver(context, now),
    async usage(keyId, scopeId) {
      return context.db.transaction(async (tx) => {
        await auth.scope(tx, keyId, scopeId, false);
        const { rows, at } = await ledger.lockScopes(tx, [scopeId]);
        const policy = await policies.latest(tx, scopeId);
        const { workspaceStarts, activeWorkspaces } = await capacityUsage(context, tx, policy, at);
        return {
          ...usageSnapshot(await ledger.records(tx), policy, at, rows[0]?.blockedReason ?? null),
          workspaceStarts,
          activeWorkspaces,
        };
      });
    },
  };
}
