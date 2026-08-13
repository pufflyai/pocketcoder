import { z } from "zod";
import { isDuration } from "./duration";
import { NetworkPolicySchema } from "./network";
import { LAUNCH_MODES, OutputDeclarationSchema, PersistenceSpecSchema } from "./persistence";
import { isAbsolutePath, SECRET_REFERENCE_PREFIX } from "./template-constants";

// Template manifests (`pocketcoder.dev/v1alpha1 Template`) are reviewed
// deployment resources. Callers select a template by name/version; they can
// never submit an image, command, mount, network, privilege, or provider.
//
// The execution surface a template owns:
//   - `spec.command`  container entrypoint (the pocketcoder-supervisor);
//   - `spec.setup`    ordered setup commands run before the harness starts;
//   - `spec.agent`    the preferred coding-agent command PocketCoder wraps in
//                     its fixed AgentAPI boundary;
//   - `spec.terminal` optional interactive access to one fixed command;
//   - `spec.harness` and `spec.services` remain a legacy compatibility profile.

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export function secretMountPath(reference: string): string {
  if (!reference.startsWith(SECRET_REFERENCE_PREFIX)) {
    throw new Error("secret reference must start with secretRef:");
  }
  const name = reference.slice(SECRET_REFERENCE_PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(name) || name.includes("..")) {
    throw new Error("invalid secret reference");
  }
  return `/run/pocketcoder/secrets/${name.replaceAll("/", "%2F")}`;
}

export const DurationSchema = z
  .string()
  .refine(isDuration, { message: "expected a duration like 15s, 20m, or 2h" });

const CommandSchema = z.array(z.string().min(1)).min(1);

const EnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());

export const SetupStepSchema = z.object({
  name: z.string().regex(NAME_RE),
  command: CommandSchema,
  timeoutSeconds: z.number().int().positive().max(3600).default(300),
  env: EnvSchema.default({}),
  cwd: z.string().refine(isAbsolutePath, "expected an absolute path").optional(),
  runOn: z.array(z.enum(LAUNCH_MODES)).min(1).default(["create"]),
});

export const HarnessSchema = z.object({
  command: CommandSchema,
  env: EnvSchema.default({}),
  cwd: z.string().refine(isAbsolutePath, "expected an absolute path").optional(),
});

export const AgentSchema = HarnessSchema.extend({
  type: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .default("custom"),
  transport: z.enum(["pty", "acp"]).default("pty"),
  termWidth: z.number().int().min(10).max(65_535).optional(),
  stateFile: z.string().refine(isAbsolutePath, "expected an absolute path").optional(),
});

export const TerminalSchema = z.object({
  command: CommandSchema,
  env: EnvSchema.default({}),
  cwd: z.string().refine(isAbsolutePath, "expected an absolute path").optional(),
  maxSessions: z.number().int().min(1).max(8).default(2),
  idleTimeout: DurationSchema.default("10m"),
});

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const ServiceRouteSchema = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string(),
  query: z.array(z.string().min(1)).default([]),
  responseMode: z.enum(["buffered", "stream"]).default("buffered"),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(65_536),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(1_048_576),
  deadlineSeconds: z.number().int().positive().max(300).default(60),
});

export const ServiceSchema = z.object({
  baseUrl: z.string(),
  required: z.boolean().default(true),
  healthPath: z.string().default("/status"),
  routes: z.array(ServiceRouteSchema).min(1),
});

export const SecuritySchema = z.object({
  uid: z.number().int().min(1000).default(10_001),
  gid: z.number().int().min(1000).default(10_001),
  readOnlyRoot: z.boolean().default(true),
  writableMemoryPaths: z
    .array(z.string().refine(isAbsolutePath, "expected an absolute path"))
    .default(["/tmp"]),
  dropCapabilities: z.array(z.string()).default(["ALL"]),
  allowPrivilegeEscalation: z.literal(false).default(false),
  seccomp: z.literal("RuntimeDefault").default("RuntimeDefault"),
});

export const TimeoutsSchema = z.object({
  start: DurationSchema.default("2m"),
  maxAge: DurationSchema.default("2h"),
  idle: DurationSchema.default("20m"),
  disconnectGrace: DurationSchema.default("5m"),
  terminateGrace: DurationSchema.default("15s"),
});

export const ResourcesSchema = z.object({
  cpu: z.string().regex(/^\d+(\.\d+)?m?$/),
  memory: z.string().regex(/^\d+(Mi|Gi)$/),
});

const RepositorySchema = z.object({
  url: z.url().refine((value) => {
    try {
      return new URL(value).username === "" && new URL(value).password === "";
    } catch {
      return false;
    }
  }, "repository URLs must not contain userinfo"),
  credential: z
    .string()
    .startsWith(SECRET_REFERENCE_PREFIX)
    .max(256)
    .refine((value) => {
      try {
        secretMountPath(value);
        return true;
      } catch {
        return false;
      }
    }, "credential must be a normalized secret reference")
    .optional(),
});

export const SourceSpecSchema = z.object({
  kind: z.literal("git"),
  destinationMount: z.string().regex(NAME_RE),
  repositories: z.record(z.string().regex(NAME_RE), RepositorySchema),
  allowedRevision: z.literal("branch-tag-or-commit").default("branch-tag-or-commit"),
});

export const CheckpointHookSchema = z.object({
  command: CommandSchema,
  timeoutSeconds: z.number().int().positive().max(300).default(30),
  env: EnvSchema.default({}),
  cwd: z.string().refine(isAbsolutePath, "expected an absolute path").optional(),
});

const TemplateSpecInputSchema = z
  .object({
    version: z.string().regex(SEMVER_RE),
    image: z.string().regex(IMAGE_DIGEST_RE, {
      message: "image must be digest-pinned (repo@sha256:<64 hex>)",
    }),
    command: CommandSchema.default([
      "/usr/local/bin/pocketcoder-supervisor",
      "supervise",
      "--launch-input",
      "/run/pocketcoder/input",
    ]),
    setup: z.array(SetupStepSchema).max(32).default([]),
    agent: AgentSchema.optional(),
    harness: HarnessSchema.optional(),
    terminal: TerminalSchema.optional(),
    env: EnvSchema.default({}),
    resources: ResourcesSchema,
    timeouts: TimeoutsSchema.prefault({}),
    services: z.record(z.string().regex(NAME_RE), ServiceSchema).optional(),
    security: SecuritySchema.prefault({}),
    network: NetworkPolicySchema,
    maxLaunchInputBytes: z.number().int().positive().max(1_048_576).default(65_536),
    compat: z
      .object({
        agent: z.string().optional(),
        agentapi: z.string().optional(),
      })
      .default({}),
    persistence: PersistenceSpecSchema.prefault({}),
    source: SourceSpecSchema.nullable().default(null),
    checkpointHook: CheckpointHookSchema.optional(),
    outputs: z.record(z.string().regex(NAME_RE), OutputDeclarationSchema).default({}),
  })
  .superRefine((spec, ctx) => {
    if (!spec.agent && !spec.harness) {
      ctx.addIssue({
        code: "custom",
        path: ["harness"],
        message: "either agent or harness is required",
      });
    }
    if (!spec.agent) return;
    if (spec.agent.transport === "acp" && spec.agent.termWidth !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent", "termWidth"],
        message: "termWidth is only valid for PTY transport",
      });
    }
    for (const field of ["harness", "services", "checkpointHook"] as const) {
      if (spec[field] === undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `agent cannot be combined with ${field}`,
      });
    }
  });

type TemplateSpecCommon = Omit<
  z.infer<typeof TemplateSpecInputSchema>,
  "agent" | "harness" | "services" | "checkpointHook"
>;

export type Agent = z.infer<typeof AgentSchema>;
export type Harness = z.infer<typeof HarnessSchema>;
export type Terminal = z.infer<typeof TerminalSchema>;
export type CheckpointHook = z.infer<typeof CheckpointHookSchema>;
export type TemplateService = z.infer<typeof ServiceSchema>;
export type TemplateServiceRoute = z.infer<typeof ServiceRouteSchema>;

export type TemplateSpec =
  | (TemplateSpecCommon & {
      agent: Agent;
      harness?: never;
      services?: never;
      checkpointHook?: never;
    })
  | (TemplateSpecCommon & {
      agent?: never;
      harness: Harness;
      services: Record<string, TemplateService>;
      checkpointHook?: CheckpointHook;
    });

export const TemplateSpecSchema = TemplateSpecInputSchema.transform((spec): TemplateSpec => {
  if (spec.agent) {
    const { harness: _harness, services: _services, checkpointHook: _hook, ...native } = spec;
    return { ...native, agent: spec.agent };
  }
  const { agent: _agent, ...legacy } = spec;
  return {
    ...legacy,
    harness: spec.harness as Harness,
    services: spec.services ?? {},
  };
});

export const TemplateManifestBaseSchema = z.object({
  apiVersion: z.literal("pocketcoder.dev/v1alpha1"),
  kind: z.literal("Template"),
  metadata: z.object({
    name: z.string().regex(NAME_RE),
    description: z.string().max(512).optional(),
  }),
  spec: TemplateSpecSchema,
});

export type TemplateManifest = z.infer<typeof TemplateManifestBaseSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type SourceSpec = z.infer<typeof SourceSpecSchema>;
