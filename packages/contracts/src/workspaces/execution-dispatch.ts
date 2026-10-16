import { z } from "zod";
import { JsonValueSchema } from "../common/json-value";
import { ConversationRequestIdentitySchema } from "../conversations/identity";
import { WorkloadAcceptanceSchema, WorkloadCancelSchema } from "./workload-operation";

export const ExecutionPhaseSchema = z.enum([
  "accepted",
  "dispatching",
  "running",
  "terminal",
  "canceled",
  "unknown",
  "lost",
]);
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;
export const ExecutionRecordSchema = z.strictObject({
  acceptance: WorkloadAcceptanceSchema,
  conversationIdentity: ConversationRequestIdentitySchema.nullable(),
  outcome: JsonValueSchema.nullable(),
  acceptedAt: z.iso.datetime(),
  dispatchClaimedAt: z.iso.datetime().nullable(),
  phase: ExecutionPhaseSchema,
  cancel: z.strictObject({ cancelId: z.uuid(), requestedAt: z.iso.datetime() }).nullable(),
  settledAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  finalizedAt: z.iso.datetime().nullable(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export const ExecutionStartSchema = z
  .strictObject({
    acceptance: WorkloadAcceptanceSchema,
    conversationIdentity: ConversationRequestIdentitySchema.optional(),
  })
  .refine(
    ({ acceptance, conversationIdentity }) =>
      acceptance.execution.owner !== "conversation-request" || conversationIdentity !== undefined,
    {
      path: ["conversationIdentity"],
      message: "Conversation execution requires a conversation identity.",
    },
  );
export const ExecutionCancelSchema = WorkloadCancelSchema.refine((cancel) => cancel.scope === "operation", {
  message: "Use workspace release for workspace cancellation",
});
export function executionSettled(record: ExecutionRecord) {
  return ["terminal", "canceled", "unknown", "lost"].includes(record.phase);
}
