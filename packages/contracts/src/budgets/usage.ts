import { z } from "zod";

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
