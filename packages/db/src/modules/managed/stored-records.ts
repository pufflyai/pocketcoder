import { managed } from "@pstdio/pocketcoder-contracts";

const pick = <T extends object>(value: object, keys: (keyof T)[]) =>
  Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key as keyof typeof value]]));

// Profiles and policies stored before model usage moved to the model gateway still carry model
// fields (allowedModels, token and model limits). Reads keep only the fields PocketCoder owns.
export function storedProfile(profile: object): managed.ExecutionProfile {
  return managed.ExecutionProfileSchema.parse(
    pick(profile, Object.keys(managed.ExecutionProfileSchema.shape) as never),
  );
}
export function storedPolicy(policy: managed.BudgetPolicy): managed.BudgetPolicy {
  const limits = Object.keys(managed.BudgetPolicyWriteSchema.shape.limits.shape) as never;
  return managed.BudgetPolicySchema.parse({
    ...pick(policy, Object.keys(managed.BudgetPolicySchema.shape) as never),
    limits: pick(policy.limits, limits),
  });
}
