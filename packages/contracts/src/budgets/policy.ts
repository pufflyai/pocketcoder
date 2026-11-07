import { z } from "zod";

export const BudgetPolicyWriteSchema = z.strictObject({
  scopeId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  period: z.enum(["utc_day", "utc_month"]),
  limits: z.strictObject({
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    workspaceStarts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    maxActiveWorkspaces: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    maxInFlightModelRequests: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    modelRequestsPerMinute: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    modelRequestsPerMinutePerWorkspace: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    maxRunningRequestsPerSession: z.literal(1),
    maxChatProcessesPerWorkspace: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    defaultOutputTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    maxOutputTokensPerInvocation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  modelLimits: z
    .array(
      z.strictObject({
        model: z.string().min(1).max(256),
        inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
        outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
      }),
    )
    .max(1000),
});
export type BudgetPolicyWrite = z.infer<typeof BudgetPolicyWriteSchema>;

export const BudgetPolicySchema = BudgetPolicyWriteSchema.extend({ effectiveAt: z.iso.datetime({ offset: true }) });
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
