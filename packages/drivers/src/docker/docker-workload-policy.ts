import {
  canonicalJson,
  type InstalledWorkload,
  WORKLOAD_CAPABILITIES,
  type WorkloadTemplate,
} from "@pstdio/pocketcoder-contracts";
import type { InputProjectionStorage } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";

const artifact = z
  .string()
  .regex(/^\/opt\/[a-zA-Z0-9_./-]+$/)
  .refine((p) => !p.split("/").includes(".."));
const pin = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const descriptorSchema = z.strictObject({
  format: z.literal("pocketcoder.image/v1"),
  codeRoots: z.array(z.string().regex(/^\/[a-zA-Z0-9_/-]+$/)).min(1),
  runtime: z.strictObject({
    digest: pin,
    protocol: z.literal("pocketcoder.workload/v1"),
    artifact,
    command: z.array(z.string()).min(1),
    entrypoint: z.array(z.string()),
  }),
  checkpoint: z
    .strictObject({
      artifact,
      digest: pin,
      command: z.array(z.string()).min(1),
      cwd: z.string().optional(),
      environment: z.array(z.string()),
      ownsServiceDescendants: z.literal(true),
    })
    .optional(),
  adapters: z.record(
    z.string(),
    z.strictObject({
      kind: z.literal("service"),
      baseUrl: z.string(),
      healthPath: z.string(),
      digest: pin,
      protocol: z.literal("pocketcoder.execution/v1"),
      artifact,
      capabilities: z.array(z.enum(WORKLOAD_CAPABILITIES)),
      command: z.array(z.string()).min(1),
      cwd: z.string().optional(),
      environment: z.array(z.string()),
    }),
  ),
});
export type Descriptor = z.infer<typeof descriptorSchema>;

export function descriptorArtifacts(descriptor: Descriptor) {
  return [
    descriptor.runtime,
    ...Object.values(descriptor.adapters),
    ...(descriptor.checkpoint ? [descriptor.checkpoint] : []),
  ];
}

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function qualifyAdapters(
  spec: WorkloadTemplate["spec"],
  descriptor: Descriptor,
  mounts: { Destination: string }[],
  storage?: InputProjectionStorage,
) {
  const writable = [...mounts.map((mount) => mount.Destination), ...spec.security.writableMemoryPaths];
  if (descriptor.codeRoots.some((root) => writable.some((path) => overlaps(root, path))))
    throw new Error("A writable runtime mount aliases installed workload code.");
  for (const entry of descriptorArtifacts(descriptor))
    if (!descriptor.codeRoots.some((root) => entry.artifact.startsWith(`${root}/`)))
      throw new Error("Installed artifact is outside image-owned code roots.");
  const hook = spec.lifecycle?.checkpointHook;
  if (hook) {
    const owned = descriptor.checkpoint;
    if (
      !owned ||
      canonicalJson(hook.command) !== canonicalJson(owned.command) ||
      hook.cwd !== owned.cwd ||
      Object.keys(hook.env).some((key) => !owned.environment.includes(key))
    )
      throw new Error("Checkpoint hook is not owned by the installed image.");
  }
  const adapters: InstalledWorkload["adapters"] = {};
  for (const [name, declared] of Object.entries(spec.adapters)) {
    const observed = descriptor.adapters[name];
    if (
      !observed ||
      observed.digest !== declared.digest ||
      observed.protocol !== declared.protocol ||
      observed.kind !== declared.kind
    )
      throw new Error(`Installed workload adapter differs: ${name}`);
    const service = declared.service ? spec.services[declared.service] : undefined;
    const process = service?.process;
    if (
      !service ||
      !process ||
      service.baseUrl !== observed.baseUrl ||
      service.healthPath !== observed.healthPath ||
      canonicalJson(process.command) !== canonicalJson(observed.command) ||
      process.cwd !== observed.cwd ||
      Object.keys(process.env).some((key) => !observed.environment.includes(key))
    )
      throw new Error(`Installed adapter startup or transport differs: ${name}`);
    const capabilities: InstalledWorkload["capabilities"] = observed.capabilities.filter(
      (cap) => cap !== "immutable-inputs",
    );
    if (storage) capabilities.push("immutable-inputs");
    adapters[name] = { kind: observed.kind, digest: observed.digest, protocol: observed.protocol, capabilities };
  }
  const bound = new Set(Object.values(spec.adapters).map((adapter) => adapter.service));
  if (Object.keys(spec.services).some((name) => !bound.has(name)))
    throw new Error("Unmeasured infrastructure service.");
  return adapters;
}
