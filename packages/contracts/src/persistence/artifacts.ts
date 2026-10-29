import { z } from "zod";

const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const KEY = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;

// A private file the harness writes into a persisted mount, readable by the control plane
// from the latest checkpoint. Diagnostics only: never a second source of conversation history.
export const PrivateArtifactSchema = z.object({
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
  // A mount name, checked against the template's declared mounts when the artifact is read.
  mount: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
  // Relative path segments; at most one `*` segment, filled by the reader's `key`.
  pattern: z
    .string()
    .max(512)
    .refine((pattern) => {
      const segments = pattern.split("/");
      return (
        segments.every((segment) => segment === "*" || SEGMENT.test(segment)) &&
        segments.filter((segment) => segment === "*").length <= 1
      );
    }, "pattern must be relative path segments with at most one * segment"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .default(8 * 1024 * 1024),
});
export type PrivateArtifact = z.infer<typeof PrivateArtifactSchema>;

// The file a key selects, or null when the key does not fit the pattern.
export function artifactPath(artifact: Pick<PrivateArtifact, "pattern">, key: string | undefined) {
  const wildcard = artifact.pattern.split("/").includes("*");
  if (!wildcard) return key === undefined ? artifact.pattern : null;
  if (key === undefined || !KEY.test(key)) return null;
  return artifact.pattern
    .split("/")
    .map((segment) => (segment === "*" ? key : segment))
    .join("/");
}
