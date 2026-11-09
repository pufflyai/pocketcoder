import { managed } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export type BudgetScopeGrant = z.infer<typeof managed.managedSchemas.BudgetScopeGrant>;
export type CredentialBinding = z.infer<typeof managed.managedSchemas.CredentialBinding>;

const scopePath = (scopeId: string) => `/v1/budget-scopes/${encodeURIComponent(scopeId)}`;

// Managed authority: budget scopes, their physical capacity policies, execution profiles and
// credential bindings. Model access and spend belong to the deployment's model gateway.
export class ManagedAuthorityApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  async grantScope(scopeId: string, grant: BudgetScopeGrant, options: RequestOptions = {}) {
    await this.transport.request(`${scopePath(scopeId)}/grant`, z.undefined(), {
      ...options,
      method: "PUT",
      body: JSON.stringify(managed.managedSchemas.BudgetScopeGrant.parse(grant)),
    });
  }

  // Writes the next policy revision. Pass `expectedRevision: null` for the first revision; an
  // identical retry returns the committed revision.
  putPolicy(policy: managed.BudgetPolicyWrite, expectedRevision: number | null, options: RequestOptions = {}) {
    return this.transport.request(`${scopePath(policy.scopeId)}/policy`, managed.BudgetPolicySchema, {
      ...options,
      method: "PUT",
      body: JSON.stringify(managed.BudgetPolicyWriteSchema.parse(policy)),
      headers: expectedRevision === null ? { "if-none-match": "*" } : { "if-match": `"${expectedRevision}"` },
    });
  }

  getPolicy(scopeId: string, options: RequestOptions = {}) {
    return this.transport.request(`${scopePath(scopeId)}/policy`, managed.BudgetPolicySchema, options);
  }

  // Physical capacity used in the current period.
  usage(scopeId: string, options: RequestOptions = {}) {
    return this.transport.request(`${scopePath(scopeId)}/usage`, managed.BudgetUsageSchema, options);
  }

  // Immutable; publish a new revision to change a profile.
  putProfile(principalId: string, profile: managed.ExecutionProfile, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/execution-profiles/${encodeURIComponent(profile.profileId)}/revisions/${profile.revision}?principalId=${encodeURIComponent(principalId)}`,
      managed.ExecutionProfileSchema,
      { ...options, method: "PUT", body: JSON.stringify(managed.ExecutionProfileSchema.parse(profile)) },
    );
  }

  async putCredentialBinding(binding: CredentialBinding, options: RequestOptions = {}) {
    await this.transport.request(`/v1/credential-bindings/${encodeURIComponent(binding.bindingId)}`, z.undefined(), {
      ...options,
      method: "PUT",
      body: JSON.stringify(managed.managedSchemas.CredentialBinding.parse(binding)),
    });
  }
}
