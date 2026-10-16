import { z } from "zod";
import { JsonValueSchema } from "../common/json-value";
import { HarnessSchema } from "../templates/template-alpha-schema";
import { WorkloadDigestSchema, WorkloadProfileSchema } from "../templates/workload-capabilities";
import { WorkloadExecutionReferenceSchema } from "./workload-operation";

export const ProcessReferenceSchema = WorkloadExecutionReferenceSchema.extend({ owner: z.literal("process") });
export type ProcessReference = z.infer<typeof ProcessReferenceSchema>;
export const FiniteProcessFactSchema = z
  .strictObject({
    execution: ProcessReferenceSchema,
    fingerprint: WorkloadDigestSchema,
    phase: z.enum(["claimed", "running", "exited", "lost"]),
    processGroupId: z.number().int().positive().nullable(),
    claimedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
  })
  .superRefine((fact, ctx) => {
    const terminal = fact.phase === "exited" || fact.phase === "lost";
    if (terminal !== (fact.endedAt !== null))
      ctx.addIssue({ code: "custom", message: "terminal facts require an end time" });
    if (fact.phase === "exited" && (fact.exitCode === null) === (fact.signal === null))
      ctx.addIssue({ code: "custom", message: "exit requires exactly one observed code or signal" });
    if (fact.phase !== "exited" && (fact.exitCode !== null || fact.signal !== null))
      ctx.addIssue({ code: "custom", message: "unobserved exits cannot have a code or signal" });
    if (fact.phase === "running" && (!fact.processGroupId || !fact.startedAt))
      ctx.addIssue({ code: "custom", message: "running facts require an owned process group and start time" });
  });
export type FiniteProcessFact = z.infer<typeof FiniteProcessFactSchema>;

export const WaitingRuntimeSpecSchema = z.strictObject({
  incarnationId: z.string().min(1).max(256),
  profile: WorkloadProfileSchema,
  operations: z.record(z.string(), HarnessSchema),
  infrastructure: z.record(z.string(), HarnessSchema),
});
export type WaitingRuntimeSpec = z.infer<typeof WaitingRuntimeSpecSchema>;
export const ProcessStartPayload = z.strictObject({
  execution: ProcessReferenceSchema,
  fingerprint: WorkloadDigestSchema,
  input: z.record(z.string(), JsonValueSchema).default({}),
  inputDirectory: z.string().min(1).optional(),
  operation: z.string().min(1).max(64),
});
export const ProcessTargetPayload = z.strictObject({ execution: ProcessReferenceSchema });
export const ProcessCancelPayload = ProcessTargetPayload.extend({
  cancelId: z.uuid(),
  signal: z.enum(["SIGTERM", "SIGKILL"]),
  graceMs: z.number().int().nonnegative(),
});

export const ProcessCancelResultPayload = ProcessTargetPayload.extend({
  cancelId: z.uuid(),
  status: z.enum(["canceled", "requested", "terminal"]),
});
