import { randomUUID } from "node:crypto";
import type { managed, PocketCoderClient } from "@pstdio/pocketcoder-sdk";

export interface CapacityLimits {
  workspaceStarts: number | null;
  maxActiveWorkspaces: number | null;
  maxChatProcessesPerWorkspace: number;
}

// One-time operator setup with an owner key, kept outside every workspace. Each controller has one
// installation scope; pass it when it already exists. The consumer's own opaque scope (for example
// one per customer account) gets its own capacity policy. Model spend is set in the model gateway.
export async function provision(
  admin: PocketCoderClient,
  input: {
    principalId: string;
    templateDigest: string;
    limits: CapacityLimits;
    installationScopeId?: string;
    credentialBindingId?: string;
  },
) {
  const scopeIds = [];
  if (!input.installationScopeId) scopeIds.push(await scope(admin, input.principalId, true, input.limits));
  else scopeIds.push(input.installationScopeId);
  const scopeId = await scope(admin, input.principalId, false, input.limits);
  scopeIds.push(scopeId);
  const profile = await admin.authority.putProfile(input.principalId, {
    profileId: randomUUID(),
    revision: 1,
    isolationScopeId: randomUUID(),
    budgetScopeIds: scopeIds,
    templateDigest: input.templateDigest,
    credentialBindingId: input.credentialBindingId ?? null,
  });
  return { scopeId, profile };
}

async function scope(admin: PocketCoderClient, principalId: string, installation: boolean, limits: CapacityLimits) {
  const scopeId = randomUUID();
  await admin.authority.grantScope(scopeId, { principalId, installation });
  const policy: managed.BudgetPolicyWrite = {
    scopeId,
    revision: 1,
    period: "utc_day",
    limits: { ...limits, maxRunningRequestsPerSession: 1 },
  };
  await admin.authority.putPolicy(policy, null);
  return scopeId;
}
