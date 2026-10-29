import { z } from "zod";
import { canonicalJson, digestOf } from "../common/canonical";
import { NetworkPolicySchema } from "../network/network";
import { PersistenceSpecSchema } from "../persistence/persistence";
import { PreviewsSchema } from "../previews/preview";
import { CredentialSlotSchema } from "../secrets/credential-slot";
import {
  CheckpointHookSchema,
  HarnessSchema,
  ResourcesSchema,
  SecuritySchema,
  ServiceSchema,
  TimeoutsSchema,
} from "./template-alpha-schema";
import {
  WorkloadCapabilitySchema,
  WorkloadDigestSchema,
  WorkloadImageSchema,
  WorkloadLimitsSchema,
  WorkloadNameSchema,
  WorkloadProfileSchema,
  WorkloadRuntimePinSchema,
} from "./workload-capabilities";
import { WorkloadInputSchema } from "./workload-input-schema";
import { validateWorkloadTemplate } from "./workload-validation";

export const WorkloadAdapterSchema = z.strictObject({
  kind: z.enum(["process", "service", "pi", "agentapi"]),
  digest: WorkloadDigestSchema,
  protocol: z.string().min(1).max(128),
  command: HarnessSchema.shape.command.optional(),
  cwd: HarnessSchema.shape.cwd,
  env: HarnessSchema.shape.env,
  service: WorkloadNameSchema.optional(),
});

export const WorkloadOperationSchema = z.strictObject({
  adapter: WorkloadNameSchema,
  inputSchema: WorkloadInputSchema,
  requiredCapabilities: z.array(WorkloadCapabilitySchema),
  outputRoots: z.array(z.string()).max(16),
});
export type WorkloadOperation = z.infer<typeof WorkloadOperationSchema>;

export const WorkloadTemplateBaseSchema = z.strictObject({
  apiVersion: z.literal("pocketcoder.dev/v1"),
  kind: z.literal("Template"),
  metadata: z.strictObject({ name: WorkloadNameSchema, description: z.string().max(512).optional() }),
  spec: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    image: WorkloadImageSchema,
    runtime: WorkloadRuntimePinSchema,
    profile: WorkloadProfileSchema,
    adapters: z.record(WorkloadNameSchema, WorkloadAdapterSchema),
    operations: z.record(WorkloadNameSchema, WorkloadOperationSchema),
    services: z.record(
      WorkloadNameSchema,
      ServiceSchema.extend({ process: HarnessSchema.strict().optional() }).strict(),
    ),
    previews: PreviewsSchema,
    credentialSlots: z.record(WorkloadNameSchema, CredentialSlotSchema),
    resources: ResourcesSchema.strict(),
    network: NetworkPolicySchema,
    security: SecuritySchema.strict(),
    limits: WorkloadLimitsSchema,
    lifecycle: z
      .strictObject({
        persistence: PersistenceSpecSchema.prefault({}),
        checkpointHook: CheckpointHookSchema.optional(),
        timeouts: TimeoutsSchema.optional(),
        maxLaunchInputBytes: z.number().int().positive().max(1_048_576).default(65_536),
      })
      .optional(),
  }),
});
export type WorkloadTemplate = z.infer<typeof WorkloadTemplateBaseSchema>;
export const WorkloadTemplateSchema = WorkloadTemplateBaseSchema.superRefine(validateWorkloadTemplate);

export function parseWorkloadTemplate(input: unknown) {
  const manifest = WorkloadTemplateSchema.parse(input);
  return { manifest, canonical: canonicalJson(manifest), digest: digestOf(manifest) };
}

export const WorkloadTemplateSnapshotSchema = z
  .strictObject({
    format: z.literal("pocketcoder.dev/v1"),
    name: WorkloadNameSchema,
    version: z.string(),
    digest: WorkloadDigestSchema,
    manifest: WorkloadTemplateSchema,
  })
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.name !== snapshot.manifest.metadata.name ||
      snapshot.version !== snapshot.manifest.spec.version ||
      snapshot.digest !== digestOf(snapshot.manifest)
    ) {
      ctx.addIssue({ code: "custom", message: "snapshot identity does not match its immutable manifest" });
    }
  });
export type WorkloadTemplateSnapshot = z.infer<typeof WorkloadTemplateSnapshotSchema>;

export function workloadSnapshotOf(parsed: ReturnType<typeof parseWorkloadTemplate>) {
  return WorkloadTemplateSnapshotSchema.parse({
    format: parsed.manifest.apiVersion,
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    manifest: parsed.manifest,
  });
}
