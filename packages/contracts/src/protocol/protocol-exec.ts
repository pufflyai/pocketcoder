import { z } from "zod";
import { DisplaySchema } from "../displays/display";
import { CONVERSATION_RESTORE_CAPABILITIES, LAUNCH_MODES, SourceDescriptorSchema } from "../persistence/persistence";
import { PreviewsSchema } from "../previews/preview";
import { HarnessSchema, ServiceSchema, SetupStepSchema, TimeoutsSchema } from "../templates/template";
import { RestoreTransferSpecSchema } from "./protocol-checkpoint";

export const SOURCE_CREDENTIAL_MAX_BYTES = 65_536;
export const RestoreModeSchema = z.enum(["provider_installed", "controller_archive"]);
export type RestoreMode = z.infer<typeof RestoreModeSchema>;

// The exec spec delivers the template-owned setup commands, harness command,
// service allowlist, and timeouts to the supervisor at registration time, so
// custom setup and custom harnesses require no image rebuild.
export const ExecSpecSchema = z.object({
  agentapi_native: z.boolean().default(false),
  setup: z.array(SetupStepSchema),
  harness: HarnessSchema,
  env: z.record(z.string(), z.string()),
  services: z.record(z.string(), ServiceSchema),
  previews: PreviewsSchema.optional(),
  display: DisplaySchema.optional(),
  terminal: z
    .object({
      command: z.array(z.string().min(1)).min(1),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()),
      max_sessions: z.number().int().min(1).max(8),
      idle_timeout_seconds: z.number().int().positive(),
      replay_buffer_bytes: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  timeouts: TimeoutsSchema,
  security: z
    .object({
      writable_memory_paths: z.array(z.string()),
    })
    .default({ writable_memory_paths: [] }),
  network: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("unrestricted") }),
      z.object({
        mode: z.literal("restricted"),
        proxy_url: z.url(),
        health_url: z.url(),
      }),
    ])
    .default({ mode: "unrestricted" }),
  launch_mode: z.enum(LAUNCH_MODES).default("create"),
  source: SourceDescriptorSchema.extend({
    url: z.url(),
    destination: z.string(),
    max_bytes: z.number().int().positive().optional(),
    max_files: z.number().int().positive().optional(),
    credential_expires_at: z.iso.datetime().nullable().default(null),
    credential: z
      .string()
      .min(1)
      .max(SOURCE_CREDENTIAL_MAX_BYTES)
      .refine((value) => !value.includes("\0"), "credential must not contain NUL bytes")
      .nullable()
      .default(null),
  })
    .nullable()
    .default(null),
  restore: z
    .object({
      mode: RestoreModeSchema,
      checkpoint_id: z.uuid(),
      origin_workspace_id: z.uuid(),
      transfer: RestoreTransferSpecSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
  persistence: z.object({
    mounts: z.array(z.object({ name: z.string(), target: z.string() })),
    conversation_restore: z.enum(CONVERSATION_RESTORE_CAPABILITIES),
  }),
  checkpoint_hook: z
    .object({
      command: z.array(z.string().min(1)).min(1),
      timeout_seconds: z.number().int().positive(),
      env: z.record(z.string(), z.string()),
      cwd: z.string().optional(),
    })
    .nullable(),
  outputs: z.record(z.string(), z.unknown()),
});

export type ExecSpec = z.infer<typeof ExecSpecSchema>;
