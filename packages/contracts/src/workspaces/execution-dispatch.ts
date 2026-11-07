import { z } from "zod";
import { digestOf } from "../common/canonical";
import { JsonValueSchema } from "../common/json-value";
import { ConversationRequestIdentitySchema } from "../conversations/identity";
import { WorkloadExportReferenceSchema } from "../outputs/export-reference";
import { type WorkloadAcceptance, WorkloadAcceptanceSchema, WorkloadCancelSchema } from "./workload-operation";

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
  producerSendClaimedAt: z.iso.datetime().optional(),
  finalizationBasis: z.enum(["never_sent", "producer_acknowledged", "runtime_fenced"]).optional(),
  phase: ExecutionPhaseSchema,
  cancel: z.strictObject({ cancelId: z.uuid(), requestedAt: z.iso.datetime() }).nullable(),
  settledAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  finalizedAt: z.iso.datetime().nullable(),
  collection: WorkloadExportReferenceSchema.optional(),
  publicationComplete: z.boolean().optional(),
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
export function executionNeedsAcknowledgment(record: ExecutionRecord) {
  if (record.finalizationBasis === "runtime_fenced" || record.finalizationBasis === "never_sent") return false;
  return record.dispatchClaimedAt !== null && ["terminal", "canceled"].includes(record.phase) && !record.acknowledgedAt;
}

export function executionInputManifestId(input: Pick<WorkloadAcceptance, "callerPrincipalId" | "execution">) {
  const hash = digestOf({
    domain: "execution-input-manifest/v1",
    callerPrincipalId: input.callerPrincipalId,
    execution: input.execution,
  }).slice(7);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
