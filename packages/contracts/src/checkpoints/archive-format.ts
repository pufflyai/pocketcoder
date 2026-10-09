import { posix } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../common/canonical";
import { PersistenceMountSchema } from "../persistence/persistence";

export const CHECKPOINT_ARCHIVE_FORMAT = "pocketcoder-checkpoint-tar/v1";
export const CHECKPOINT_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_IO_BYTES = 65_536;
export const CHECKPOINT_DOCUMENT_BYTES = 32 * 1024;
export const CHECKPOINT_ENTRY_BYTES = 16 * 1024;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const mount = z.strictObject({ name: PersistenceMountSchema.shape.name, logical_bytes: count, file_count: count });
const mounts = z
  .array(mount)
  .max(16)
  .refine((items) => new Set(items.map((item) => item.name)).size === items.length);

export const CheckpointArchiveHeaderSchema = z.strictObject({
  format: z.literal(CHECKPOINT_ARCHIVE_FORMAT),
  checkpoint_id: z.uuid(),
  workspace_id: z.uuid(),
  template_digest: digest,
  mounts,
});
export type CheckpointArchiveHeader = z.infer<typeof CheckpointArchiveHeaderSchema>;

function validUnicode(value: string) {
  return Buffer.from(value).toString("utf8") === value;
}

export function safeCheckpointPath(value: string) {
  return (
    validUnicode(value) &&
    value === value.normalize("NFC") &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function safeCheckpointLink(path: string, target: string) {
  if (!target || !validUnicode(target) || target.startsWith("/") || target.includes("\0") || target.includes("\\"))
    return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== ".." && !resolved.startsWith("../") && !posix.isAbsolute(resolved);
}

const common = {
  mount: z.number().int().min(0).max(15),
  path: z.string().refine(safeCheckpointPath),
  mode: z.number().int().min(0).max(0o777),
  mtime_ns: z.string().regex(/^(0|[1-9]\d*)$/),
};
export const CheckpointArchiveEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("directory"), size: z.literal(0) }),
  z.strictObject({ ...common, kind: z.literal("file"), size: count, digest }),
  z
    .strictObject({
      ...common,
      kind: z.literal("symlink"),
      mode: z.literal(0o777),
      size: count,
      digest,
      link_target: z.string(),
    })
    .refine(
      (entry) =>
        safeCheckpointLink(entry.path, entry.link_target) &&
        entry.size === Buffer.byteLength(entry.link_target) &&
        entry.digest === `sha256:${sha256Hex(entry.link_target)}`,
    ),
]);
export type CheckpointArchiveEntry = z.infer<typeof CheckpointArchiveEntrySchema>;

export const CheckpointArchiveSummarySchema = z.strictObject({
  mounts,
  manifest_digest: digest,
  content_digest: digest,
});
export type CheckpointArchiveSummary = z.infer<typeof CheckpointArchiveSummarySchema>;

export function checkpointDocument<T>(bytes: Buffer, schema: z.ZodType<T>, name: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = schema.parse(JSON.parse(text));
    if (!Buffer.from(canonicalJson(value)).equals(bytes)) throw new Error("noncanonical JSON");
    return value;
  } catch {
    throw new Error(`Invalid checkpoint ${name} document.`);
  }
}

export function checkpointIndex(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid checkpoint entry index.");
  return value.toString(16).padStart(16, "0");
}
