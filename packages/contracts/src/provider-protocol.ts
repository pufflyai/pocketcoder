import { z } from "zod";
import { LAUNCH_MODES, SourceDescriptorSchema } from "./persistence";

// Pool enrollment is a separate header/connection contract; its version
// number coinciding with a workspace protocol version carries no meaning.
export const POOL_PROTOCOL_VERSION = 3;

// The provider input file mounted read-only into each workspace. It contains
// no machine key, provider credential, or LLM credential.
export const ProviderInputSchema = z.object({
  workspace_id: z.uuid(),
  server_url: z.string(),
  registration_secret: z.string(),
  template_digest: z.string(),
  template_name: z.string().default("unknown"),
  template_version: z.string().default("unknown"),
  launch_mode: z.enum(LAUNCH_MODES).default("create"),
  source: SourceDescriptorSchema.optional(),
  restore: z
    .object({
      checkpoint_id: z.uuid(),
      origin_workspace_id: z.uuid(),
    })
    .optional(),
  launch_input: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderInput = z.infer<typeof ProviderInputSchema>;

// Bootstrap input for an unbound warm runtime. It deliberately excludes every
// workspace/caller field; the one-shot workspace input arrives in memory only
// after the control plane has durably committed a lease.
export const PoolProviderInputSchema = z.object({
  pool_runtime_id: z.uuid(),
  server_url: z.string(),
  enrollment_secret: z.string().min(1),
  template_digest: z.string(),
  template_name: z.string(),
  template_version: z.string(),
});

export type PoolProviderInput = z.infer<typeof PoolProviderInputSchema>;

export const ProviderBootstrapInputSchema = z.union([ProviderInputSchema, PoolProviderInputSchema]);
export type ProviderBootstrapInput = z.infer<typeof ProviderBootstrapInputSchema>;

export const PoolRegisteredFrameSchema = z.object({
  v: z.literal(POOL_PROTOCOL_VERSION),
  type: z.literal("pool_registered"),
  pool_runtime_id: z.uuid(),
  template: z.object({ name: z.string(), version: z.string(), digest: z.string() }),
  agent_version: z.string(),
});

export const LeaseAssignmentFrameSchema = z.object({
  v: z.literal(POOL_PROTOCOL_VERSION),
  type: z.literal("lease_assignment"),
  input: ProviderInputSchema,
});
