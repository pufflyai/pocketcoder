import type { GatewayBudgets } from "./grant";

// Run before the gateway accepts calls after a restart. A reserved call was never claimed, so it
// was never sent and its hold can go. A claimed call may have reached the provider: it keeps its
// full hold as uncertain usage and is never sent again. Only trusted evidence or audited
// reconciliation can settle it later.
export async function reconcileGatewayInvocations(budgets: GatewayBudgets) {
  const result = { abandoned: 0, uncertain: 0 };
  for (const invocation of await budgets.openInvocations()) {
    if (invocation.state === "reserved") {
      await budgets.abandonUnsent(invocation.identity);
      result.abandoned++;
    } else {
      await budgets.retainUncertain(invocation.identity);
      result.uncertain++;
    }
  }
  return result;
}
