import { z } from "zod";
import { ExportObjectSchema } from "./files";

const fields = z.strictObject({
  sessionId: z.uuid(),
  requestId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "finalizing", "settled"]),
  completeness: z.enum(["complete", "partial", "lost"]).nullable(),
  manifestDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  objects: z.array(ExportObjectSchema).max(1000),
  errors: z.array(z.string().min(1).max(512)).max(100),
  settledAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  cleanupState: z.enum(["not_required", "pending", "complete"]),
});

export const CollectionResultSchema = z
  .union([
    fields.extend({
      state: z.enum(["pending", "finalizing"]),
      completeness: z.null(),
      manifestDigest: z.null(),
      settledAt: z.null(),
      expiresAt: z.null(),
    }),
    fields.extend({
      state: z.literal("settled"),
      completeness: z.enum(["complete", "partial", "lost"]),
      manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      settledAt: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.completeness && (value.completeness === "complete") !== (value.errors.length === 0))
      ctx.addIssue({ code: "custom", path: ["errors"], message: "Collection errors must agree with completeness" });
    for (const object of value.objects) {
      if (object.sessionId !== value.sessionId || object.requestId !== value.requestId)
        ctx.addIssue({ code: "custom", path: ["objects"], message: "Collection object owner mismatch" });
    }
  });
export type CollectionResult = z.infer<typeof CollectionResultSchema>;
