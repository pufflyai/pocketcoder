import { z } from "zod";

export const LifetimeExtensionSchema = z.strictObject({
  extensionId: z.uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deadlineAt: z.iso.datetime(),
});
export type LifetimeExtension = z.infer<typeof LifetimeExtensionSchema>;
export const LifetimeReceiptSchema = LifetimeExtensionSchema.extend({
  workspaceId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ceilingAt: z.iso.datetime(),
});
export type LifetimeReceipt = z.infer<typeof LifetimeReceiptSchema>;
export interface WorkspaceLifetime {
  ceilingAt: string;
  revision: number;
  extensions: Record<string, LifetimeReceipt>;
}
