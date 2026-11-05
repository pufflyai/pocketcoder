import { z } from "zod";

export const BudgetUsageSchema = z.strictObject({
  scopeId: z.uuid(),
  policyRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  settledInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  settledOutputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  heldInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  heldOutputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  effectiveInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  effectiveOutputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  remainingInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  remainingOutputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  workspaceStarts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeWorkspaces: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  inFlightModelRequests: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unresolvedInvocations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  oldestUnresolvedAt: z.iso.datetime({ offset: true }).nullable(),
  blockedReason: z.string().min(1).max(256).nullable(),
  asOf: z.iso.datetime({ offset: true }),
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

const CleanupReceiptFieldsSchema = z.strictObject({
  workspaceId: z.uuid(),
  generationId: z.string().min(1).max(256),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "proved"]),
  basis: z.enum(["never_launched", "processes_exited", "provider_fenced"]).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  capacityReleasedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const CleanupReceiptSchema = z.union([
  CleanupReceiptFieldsSchema.extend({ state: z.literal("pending"), basis: z.null(), capacityReleasedAt: z.null() }),
  CleanupReceiptFieldsSchema.extend({
    state: z.literal("proved"),
    basis: z.enum(["never_launched", "processes_exited", "provider_fenced"]),
  }),
]);
export type CleanupReceipt = z.infer<typeof CleanupReceiptSchema>;
