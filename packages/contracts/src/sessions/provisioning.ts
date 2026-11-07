import { z } from "zod";

export const BudgetScopeGrantSchema = z.strictObject({ principalId: z.uuid(), installation: z.boolean() });
export const CredentialBindingSchema = z.strictObject({
  bindingId: z.uuid(),
  principalId: z.uuid(),
  secretName: z.string().min(1).max(128),
  secretVersionId: z.uuid().optional(),
  slots: z.array(z.string().min(1).max(128)).min(1).max(100),
  authorityExpiresAt: z.iso.datetime({ offset: true }),
});
