import { z } from "zod";
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
  }),
]);

export const ProducerCancelSchema = WorkloadCancelSchema.extend({ fingerprint: WorkloadDigestSchema });
