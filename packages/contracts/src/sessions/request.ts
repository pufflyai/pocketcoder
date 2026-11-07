import { z } from "zod";
import { CollectionResultSchema } from "./collection";
import { InputReferenceSchema, MAX_SESSION_FILE_REFERENCES } from "./files";

export const RequestInputSchema = z.strictObject({
  requestId: z.uuid(),
  message: z
    .string()
    .min(1)
    .max(262144)
    .refine((value) => value.isWellFormed(), "Message must contain valid Unicode")
    .refine((value) => new TextEncoder().encode(value).length <= 262144, "Message exceeds 256 KiB UTF-8"),
  attachments: z.array(InputReferenceSchema).max(MAX_SESSION_FILE_REFERENCES),
  dispatchDeadline: z.iso.datetime({ offset: true }),
});
export type RequestInput = z.infer<typeof RequestInputSchema>;

const RequestFieldsSchema = z.strictObject({
  sessionId: z.uuid(),
  requestId: z.uuid(),
  turnId: z.uuid(),
  inputFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["accepted", "waiting", "running", "checking_outcome", "terminal"]),
  outcome: z.enum(["completed", "failed", "canceled", "interrupted", "lost"]).nullable(),
  reasonCode: z.string().min(1).max(256).nullable(),
  acceptedAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  dispatchDeadline: z.iso.datetime({ offset: true }),
  collection: CollectionResultSchema,
  finalResponse: z.string().max(1048576).nullable(),
});
export const RequestSchema = z
  .union([
    RequestFieldsSchema.extend({
      state: z.literal("terminal"),
      outcome: z.enum(["completed", "failed", "canceled", "interrupted", "lost"]),
    }),
    RequestFieldsSchema.extend({
      state: z.enum(["accepted", "waiting", "running", "checking_outcome"]),
      outcome: z.null(),
      endedAt: z.null(),
    }),
  ])
  .superRefine((request, ctx) => {
    if (request.sessionId !== request.collection.sessionId || request.requestId !== request.collection.requestId)
      ctx.addIssue({ code: "custom", path: ["collection"], message: "Collection owner mismatch" });
  });
export type Request = z.infer<typeof RequestSchema>;

export const CancelCommandSchema = z.strictObject({
  cancelId: z.uuid(),
});
export type CancelCommand = z.infer<typeof CancelCommandSchema>;

const CancelReceiptFieldsSchema = z.strictObject({
  sessionId: z.uuid(),
  requestId: z.uuid().nullable(),
  cancelId: z.uuid(),
  scope: z.enum(["request", "session"]),
  state: z.enum(["pending", "completed"]),
  acceptedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  cancelDeadline: z.iso.datetime({ offset: true }),
});
const CancelTargetSchema = z.union([
  CancelReceiptFieldsSchema.extend({ scope: z.literal("request"), requestId: z.uuid() }),
  CancelReceiptFieldsSchema.extend({ scope: z.literal("session"), requestId: z.null() }),
]);
export const CancelReceiptSchema = CancelTargetSchema.superRefine((receipt, ctx) => {
  if ((receipt.state === "completed") !== (receipt.completedAt !== null)) {
    ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Completion time must agree with state" });
  }
});
export type CancelReceipt = z.infer<typeof CancelReceiptSchema>;
