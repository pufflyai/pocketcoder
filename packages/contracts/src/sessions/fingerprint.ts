import { z } from "zod";
import { digestOf } from "../common/canonical";
import { RequestInputSchema } from "./request";

export const LogicalRequestInputSchema = RequestInputSchema.extend({
  sessionId: z.uuid(),
  profileId: z.uuid(),
  profileRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).superRefine((input, ctx) => {
  // Attachment metadata participates in the digest too. UTF-8 must never replace lone surrogates.
  for (const [index, attachment] of input.attachments.entries()) {
    for (const field of ["name", "mediaType"] as const) {
      if (!attachment[field].isWellFormed()) {
        ctx.addIssue({ code: "custom", path: ["attachments", index, field], message: "Invalid Unicode" });
      }
    }
  }
});
export type LogicalRequestInput = z.infer<typeof LogicalRequestInputSchema>;

// Server only: consumers retain and retry the original input, without a physical execution fingerprint.
export function fingerprintRequest(input: unknown) {
  return digestOf(LogicalRequestInputSchema.parse(input));
}
