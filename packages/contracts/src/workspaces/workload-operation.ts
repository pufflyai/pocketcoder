import { z } from "zod";
import { AcceptedInputManifestSchema } from "../attachments/input-reference";
import { digestOf } from "../common/canonical";
import { JsonValueSchema } from "../common/json-value";
import { WorkloadDigestSchema, WorkloadNameSchema } from "../templates/workload-capabilities";

// These references compose the process and conversation owners. They do not
// introduce another mutable execution record or scheduling authority.
export const WorkloadExecutionReferenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  incarnationId: z.string().min(1).max(256),
  owner: z.enum(["process", "conversation-request"]),
  requestId: z.uuid(),
});
export type WorkloadExecutionReference = z.infer<typeof WorkloadExecutionReferenceSchema>;

export const WorkloadAcceptanceSchema = z
  .strictObject({
    execution: WorkloadExecutionReferenceSchema,
    callerPrincipalId: z.uuid(),
    templateDigest: WorkloadDigestSchema,
    adapterDigest: WorkloadDigestSchema,
    operation: WorkloadNameSchema,
    input: z.record(z.string(), JsonValueSchema),
    inputs: AcceptedInputManifestSchema,
    bindingSetDigest: WorkloadDigestSchema,
    fingerprint: WorkloadDigestSchema,
  })
  .superRefine((value, ctx) => {
    const { fingerprint, ...facts } = value;
    if (fingerprint !== digestOf(facts))
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "acceptance fingerprint does not match its facts",
      });
    if (
      value.inputs.workspaceId !== value.execution.workspaceId ||
      value.inputs.incarnationId !== value.execution.incarnationId
    ) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: "accepted input identity must match the execution" });
    }
  });
export type WorkloadAcceptance = z.infer<typeof WorkloadAcceptanceSchema>;

export const WorkloadCancelSchema = z.strictObject({
  execution: WorkloadExecutionReferenceSchema,
  cancelId: z.uuid(),
  scope: z.enum(["operation", "workspace"]),
});
export type WorkloadCancel = z.infer<typeof WorkloadCancelSchema>;
