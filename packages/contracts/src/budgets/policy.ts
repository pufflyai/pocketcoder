import { z } from "zod";

// Physical capacity limits for one budget scope. Model usage is limited by the deployment's model gateway.
export const BudgetPolicyWriteSchema = z.strictObject({
  scopeId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  period: z.enum(["utc_day", "utc_month"]),
  limits: z.strictObject({
    workspaceStarts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    maxActiveWorkspaces: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    maxRunningRequestsPerSession: z.literal(1),
    maxChatProcessesPerWorkspace: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
});
export type BudgetPolicyWrite = z.infer<typeof BudgetPolicyWriteSchema>;

export const BudgetPolicySchema = BudgetPolicyWriteSchema.extend({ effectiveAt: z.iso.datetime({ offset: true }) });
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
