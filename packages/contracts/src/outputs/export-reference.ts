import { z } from "zod";
import { AttachmentMediaTypeSchema } from "../attachments/attachment";
import { digestOf } from "../common/canonical";
import { WorkloadDigestSchema } from "../templates/workload-capabilities";
import { WorkloadExecutionReferenceSchema } from "../workspaces/workload-operation";

export const ExportObjectReferenceSchema = z.strictObject({
  objectId: z.uuid(),
  objectVersion: WorkloadDigestSchema,
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: AttachmentMediaTypeSchema,
  digest: WorkloadDigestSchema,
});
export type ExportObjectReference = z.infer<typeof ExportObjectReferenceSchema>;

export const WorkloadExportReferenceSchema = z
  .strictObject({
    exportId: z.uuid(),
    execution: WorkloadExecutionReferenceSchema,
    manifestDigest: WorkloadDigestSchema,
    completeness: z.enum(["complete", "partial", "lost"]),
    publication: z.enum(["published", "unavailable", "expired"]),
    objects: z.array(ExportObjectReferenceSchema),
    errors: z.array(z.string().min(1).max(512)),
    publishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((value, ctx) => {
    const { execution, objects, completeness, errors } = value;
    if (value.manifestDigest !== digestOf({ execution, objects, completeness, errors })) {
      ctx.addIssue({
        code: "custom",
        path: ["manifestDigest"],
        message: "export digest does not match its frozen manifest",
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.publishedAt))
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "export retention must be positive" });
    const ids = value.objects.map((object) => object.objectId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["objects"], message: "export object IDs must be unique" });
  });
export type WorkloadExportReference = z.infer<typeof WorkloadExportReferenceSchema>;
