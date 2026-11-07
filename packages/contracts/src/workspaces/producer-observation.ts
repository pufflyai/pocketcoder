import { z } from "zod";
import { AttachmentMediaTypeSchema } from "../attachments/attachment";
import { JsonValueSchema } from "../common/json-value";
import { WorkloadDigestSchema } from "../templates/workload-capabilities";
import { WorkloadCancelSchema, WorkloadExecutionReferenceSchema } from "./workload-operation";

export const ProducerObservationSchema = z.discriminatedUnion("phase", [
  z.strictObject({ execution: WorkloadExecutionReferenceSchema, phase: z.literal("absent") }),
  z.strictObject({
    execution: WorkloadExecutionReferenceSchema,
    fingerprint: WorkloadDigestSchema,
    phase: z.enum(["accepted", "running", "terminal", "canceled"]),
    outcome: JsonValueSchema.nullable(),
    publication: z
      .strictObject({
        complete: z.boolean(),
        objects: z
          .array(
            z.strictObject({
              publicationId: z.uuid(),
              name: z.string().min(1).max(255),
              mediaType: AttachmentMediaTypeSchema,
              sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              digest: WorkloadDigestSchema,
              contentBase64: z.string(),
            }),
          )
          .max(1000),
      })
      .optional(),
  }),
]);

export const ProducerCancelSchema = WorkloadCancelSchema.extend({ fingerprint: WorkloadDigestSchema });
