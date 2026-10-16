import { z } from "zod";
import { digestOf } from "../common/canonical";
import { WorkloadDigestSchema } from "../templates/workload-capabilities";
import { AttachmentMediaTypeSchema } from "./attachment";

// Public references never contain a physical backing path. Restore needs new references.
export const InputObjectReferenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  fileId: z.uuid(),
  objectVersion: WorkloadDigestSchema,
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaTypeSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: WorkloadDigestSchema,
  visibility: z.enum(["ready", "unavailable", "expired"]),
});
export type InputObjectReference = z.infer<typeof InputObjectReferenceSchema>;

export const AcceptedInputManifestSchema = z
  .strictObject({
    workspaceId: z.uuid(),
    incarnationId: z.string().min(1).max(256),
    digest: WorkloadDigestSchema,
    objects: z.array(InputObjectReferenceSchema),
  })
  .superRefine((manifest, ctx) => {
    const { digest, ...contents } = manifest;
    if (digest !== digestOf(contents))
      ctx.addIssue({ code: "custom", path: ["digest"], message: "input manifest digest does not match its objects" });
    const ids = new Set<string>();
    for (const [index, object] of manifest.objects.entries()) {
      if (object.workspaceId !== manifest.workspaceId || object.visibility !== "ready" || ids.has(object.fileId)) {
        ctx.addIssue({
          code: "custom",
          path: ["objects", index],
          message: "accepted inputs must be unique, ready and workspace-scoped",
        });
      }
      ids.add(object.fileId);
    }
  });
export type AcceptedInputManifest = z.infer<typeof AcceptedInputManifestSchema>;
