import { z } from "zod";
import { AttachmentMediaTypeSchema } from "../attachments/attachment";
import { JsonValueSchema } from "../common/json-value";
import { ConversationMessageInputSchema } from "../conversations/conversation";
import { WorkloadDigestSchema } from "../templates/workload-capabilities";
import { WorkloadCancelSchema, WorkloadExecutionReferenceSchema } from "./workload-operation";

export const ProducerPublicationObjectSchema = z.strictObject({
  publicationId: z.uuid(),
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaTypeSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: WorkloadDigestSchema,
  contentBase64: z.string(),
});
export const ProducerPublicationSchema = z.strictObject({
  complete: z.boolean(),
  objects: z.array(ProducerPublicationObjectSchema).max(1000),
});
export type ProducerPublication = z.infer<typeof ProducerPublicationSchema>;

export const ProducerObservationSchema = z.discriminatedUnion("phase", [
  z.strictObject({ execution: WorkloadExecutionReferenceSchema, phase: z.literal("absent") }),
  z.strictObject({
    execution: WorkloadExecutionReferenceSchema,
    fingerprint: WorkloadDigestSchema,
    phase: z.enum(["accepted", "running", "terminal", "canceled"]),
    outcome: JsonValueSchema.nullable(),
    messages: z.array(ConversationMessageInputSchema).max(1024).optional(),
    publication: ProducerPublicationSchema.optional(),
  }),
]);

export const ProducerCancelSchema = WorkloadCancelSchema.extend({ fingerprint: WorkloadDigestSchema });
