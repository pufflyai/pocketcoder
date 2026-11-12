import { z } from "zod";
import type { WorkloadTemplate } from "../templates/workload-template";

// Observations share the 12 MiB control frame with base64 relay and transcript data.
export const NATIVE_PUBLICATION_MAX_BYTES = 2 * 1024 * 1024;
export const NATIVE_PUBLICATION_TRANSCRIPT_BYTES = 3 * 1024 * 1024;
export const NativePublicationPolicySchema = z.strictObject({
  roots: z.array(z.string().startsWith("/").min(2)).min(1).max(100),
  bytes: z.number().int().positive().max(NATIVE_PUBLICATION_MAX_BYTES),
  files: z.number().int().positive().max(100),
});
export type NativePublicationPolicy = z.infer<typeof NativePublicationPolicySchema>;

export function executionPublicationPolicy(spec: WorkloadTemplate["spec"] | undefined, operation: string) {
  const selected = spec?.operations[operation];
  if (!spec) return;
  if (!selected?.outputRoots.length) return;
  const service = spec.adapters[selected.adapter]?.service;
  const routes = spec.services[service ?? ""]?.routes ?? [];
  const responses = ["accept", "lookup", "cancel", "ack"].map(
    (action) =>
      routes.find((route) => route.method === "POST" && route.path === `/executions/${action}`)?.maxResponseBytes ?? 0,
  );
  // The outcome repeats up to 1.5 MiB of JSON-escaped text. Reserve 2 MiB for it,
  // 100 UTF-8 descriptors and the envelope, beside the native publication transcript.
  const transportBytes = Math.floor(
    ((Math.min(...responses) - NATIVE_PUBLICATION_TRANSCRIPT_BYTES - 2 * 1024 * 1024) * 3) / 4,
  );
  if (transportBytes <= 0) return;
  return NativePublicationPolicySchema.parse({
    roots: selected.outputRoots,
    bytes: Math.min(spec.limits.exportBytes, NATIVE_PUBLICATION_MAX_BYTES, transportBytes),
    files: Math.min(spec.limits.exportFiles, 100),
  });
}
