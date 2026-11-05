import { z } from "zod";
import { ExportObjectSchema } from "./files";
import { SessionSchema } from "./profile";
import { RequestSchema } from "./request";

const RuntimeEventFieldsSchema = z.strictObject({
  eventId: z.uuid(),
  cursor: z.string().min(1).max(256),
  sessionId: z.uuid(),
  requestId: z.uuid().nullable(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  recordedAt: z.iso.datetime({ offset: true }),
  kind: z.enum(["session.updated", "request.updated", "output.published"]),
  data: z.union([SessionSchema, RequestSchema, ExportObjectSchema]),
});
export const RuntimeEventSchema = z
  .discriminatedUnion("kind", [
    RuntimeEventFieldsSchema.extend({ kind: z.literal("session.updated"), requestId: z.null(), data: SessionSchema }),
    RuntimeEventFieldsSchema.extend({ kind: z.literal("request.updated"), requestId: z.uuid(), data: RequestSchema }),
    RuntimeEventFieldsSchema.extend({
      kind: z.literal("output.published"),
      requestId: z.uuid(),
      data: ExportObjectSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    if (event.sessionId !== event.data.sessionId)
      ctx.addIssue({ code: "custom", path: ["sessionId"], message: "Session identity mismatch" });
    if (event.kind !== "session.updated" && event.requestId !== event.data.requestId)
      ctx.addIssue({ code: "custom", path: ["requestId"], message: "Request identity mismatch" });
    if (event.kind !== "output.published" && event.revision !== event.data.revision)
      ctx.addIssue({ code: "custom", path: ["revision"], message: "Resource revision mismatch" });
  });
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const ErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(256),
    message: z.string().max(512),
    retry: z.enum(["never", "same_identity", "after_capacity_change", "reconcile"]),
    retryAfterSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    requestId: z.uuid().nullable(),
  }),
});
export type ManagedError = z.infer<typeof ErrorSchema>;
