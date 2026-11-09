import { findNetworkRule, type NetworkPolicy } from "./network";

// A budgeted model route is only enforceable when the workspace cannot reach the provider itself.
// Restricted egress allows nothing else by default; any rule that reaches a provider host would
// let workspace code spend without a reservation. Returns the refusal reason, or null.
export function managedModelEgressRefusal(policy: NetworkPolicy, providerHosts: string[]) {
  if (policy.mode !== "restricted") return "network_unrestricted";
  for (const host of providerHosts)
    for (const rule of policy.allow)
      if (rule.ports.some((port) => findNetworkRule({ mode: "restricted", allow: [rule] }, host, port)))
        return "provider_route_allowed";
  return null;
}
