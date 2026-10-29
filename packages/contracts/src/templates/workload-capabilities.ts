import { z } from "zod";

export const WorkloadDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const WorkloadImageSchema = z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
export const WorkloadNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const WorkloadBoundSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const WORKLOAD_CAPABILITIES = [
  "ready-without-task",
  "live-inputs",
  "immutable-inputs",
  "serial-operations",
  "retained-exports",
  "explicit-start",
  "exact-exit",
  "targeted-cancel",
  "stop-before-export",
  "request-lookup",
  "deduplicated-accept",
  "explicit-publication",
  "workspace-services",
  "revocable-preview-grants",
  "workspace-cancel",
  "unknown-outcome",
] as const;
export const WorkloadCapabilitySchema = z.enum(WORKLOAD_CAPABILITIES);
export type WorkloadCapability = z.infer<typeof WorkloadCapabilitySchema>;
export const WorkloadProfileSchema = z.enum(["finite-process", "cloud-interactive", "service"]);

const common: WorkloadCapability[] = [
  "ready-without-task",
  "live-inputs",
  "immutable-inputs",
  "serial-operations",
  "retained-exports",
];
export const WORKLOAD_PROFILE_CAPABILITIES = {
  service: ["ready-without-task"],
  "finite-process": [...common, "explicit-start", "exact-exit", "targeted-cancel", "stop-before-export"],
  "cloud-interactive": [
    ...common,
    "request-lookup",
    "deduplicated-accept",
    "targeted-cancel",
    "explicit-publication",
    "workspace-services",
    "revocable-preview-grants",
  ],
} satisfies Record<string, WorkloadCapability[]>;

export const WORKLOAD_OPERATION_CAPABILITIES = {
  service: ["unknown-outcome"],
  "finite-process": ["explicit-start", "exact-exit", "targeted-cancel", "stop-before-export"],
  "cloud-interactive": ["request-lookup", "deduplicated-accept", "targeted-cancel", "explicit-publication"],
} satisfies Record<string, WorkloadCapability[]>;

export const WorkloadLimitsSchema = z
  .strictObject({
    deadlineSeconds: WorkloadBoundSchema,
    finalizationSeconds: WorkloadBoundSchema,
    inputFileBytes: WorkloadBoundSchema,
    stagedInputBytes: WorkloadBoundSchema,
    inputFiles: WorkloadBoundSchema,
    inFlightTransfers: WorkloadBoundSchema,
    exportBytes: WorkloadBoundSchema,
    exportFiles: WorkloadBoundSchema,
    unreferencedInputRetentionSeconds: WorkloadBoundSchema,
    exportRetentionSeconds: WorkloadBoundSchema,
  })
  .superRefine((limits, ctx) => {
    for (const [smaller, larger] of [
      ["inputFileBytes", "stagedInputBytes"],
      ["finalizationSeconds", "deadlineSeconds"],
    ] as const) {
      if (limits[smaller] > limits[larger]) {
        ctx.addIssue({ code: "custom", path: [smaller], message: `${smaller} must not exceed ${larger}` });
      }
    }
  });
export type WorkloadLimits = z.infer<typeof WorkloadLimitsSchema>;

export const WorkloadRuntimePinSchema = z.strictObject({
  digest: WorkloadDigestSchema,
  protocol: z.literal("pocketcoder.workload/v1"),
});

export const InstalledWorkloadSchema = z.strictObject({
  workspaceId: z.uuid(),
  incarnationId: z.string().min(1).max(256),
  templateDigest: WorkloadDigestSchema,
  image: WorkloadImageSchema,
  runtime: WorkloadRuntimePinSchema,
  storage: z.strictObject({
    identity: z.string().min(1).max(256),
    profile: z.enum(["controller-readonly/v1", "shared-writer-readonly/v1"]),
  }),
  capabilities: z.array(WorkloadCapabilitySchema),
  adapters: z.record(
    WorkloadNameSchema,
    z.strictObject({
      kind: z.enum(["process", "service", "pi", "agentapi"]),
      digest: WorkloadDigestSchema,
      protocol: z.string().min(1).max(128),
      capabilities: z.array(WorkloadCapabilitySchema),
    }),
  ),
});
export type InstalledWorkload = z.infer<typeof InstalledWorkloadSchema>;
