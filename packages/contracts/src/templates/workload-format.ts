import { z } from "zod";
import { parseTemplateManifest } from "./template";
import { TemplateSpecSchema } from "./template-alpha-schema";
import { WorkloadDigestSchema } from "./workload-capabilities";
import { parseWorkloadTemplate, WorkloadTemplateSnapshotSchema } from "./workload-template";

export function isWorkloadTemplate(input: unknown) {
  return (
    input !== null && typeof input === "object" && "apiVersion" in input && input.apiVersion === "pocketcoder.dev/v1"
  );
}

export function parseVersionedTemplateManifest(input: unknown) {
  return isWorkloadTemplate(input) ? parseWorkloadTemplate(input) : parseTemplateManifest(input);
}

const AlphaSnapshotSchema = z.object({
  name: z.string(),
  version: z.string(),
  digest: WorkloadDigestSchema,
  spec: TemplateSpecSchema,
});

// A format check is not capability admission. Preserve original alpha bytes and
// digests, including snapshots from before a format discriminator existed.
export function inspectTemplateSnapshot(input: unknown, supportedFormats: readonly string[]) {
  const record = input !== null && typeof input === "object" ? input : {};
  let format = "unknown";
  if ("format" in record) {
    if (typeof record.format === "string") format = record.format;
  } else if (AlphaSnapshotSchema.safeParse(input).success) {
    format = "pocketcoder.dev/v1alpha1";
  }
  const valid =
    format === "pocketcoder.dev/v1"
      ? WorkloadTemplateSnapshotSchema.safeParse(input).success
      : format === "pocketcoder.dev/v1alpha1" && AlphaSnapshotSchema.safeParse(input).success;
  if (!valid) return { format, supported: false, reason: "invalid or unknown immutable snapshot format" };
  if (!supportedFormats.includes(format))
    return { format, supported: false, reason: `unsupported immutable snapshot format: ${format}` };
  return { format, supported: true, reason: null };
}
