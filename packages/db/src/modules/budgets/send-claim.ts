import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedInvocationIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { type DatabaseContext, lock } from "../../database/context";
import { invocationAuthority } from "./invocation-authority";
import { budgetLedger } from "./ledger";

function claimable(state: string, claim: boolean) {
  if (state === "reserved") return true;
  if (claim || state === "abandoned") return false;
  throw new ApiError("budget.conflict", "A claimed invocation requires authoritative usage evidence.");
}
export function sendClaimOwner(context: DatabaseContext, now: () => Date) {
  const authority = invocationAuthority(context);
  const ledger = budgetLedger(context, now);
  async function change(identity: ManagedInvocationIdentity, claim: boolean) {
    return context.db.transaction(async (tx) => {
      const prior = await ledger.required(tx, identity);
      if (claim) await authority.session(tx, identity);
      const { rows, at } = await ledger.lockScopes(tx, prior.reservation.scopeIds);
      await lock(tx, identity.invocationId, 35);
      const record = await ledger.required(tx, identity);
      if (!claimable(record.state, claim)) return false;
      if (claim) await authority.send(tx, record, at);
      if (claim && rows.some((row) => row.blockedReason))
        throw new ApiError("budget.exhausted", "Budget scope requires reconciliation.");
      record.state = claim ? "send_claimed" : "abandoned";
      record.touchedUntil = at;
      await ledger.write(tx, record);
      return true;
    });
  }
  return {
    claimSend: (id: ManagedInvocationIdentity) => change(id, true),
    abandonUnsent: async (id: ManagedInvocationIdentity) => {
      await change(id, false);
    },
  };
}
