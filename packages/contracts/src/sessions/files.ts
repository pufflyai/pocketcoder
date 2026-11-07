import { z } from "zod";
import { AttachmentMediaTypeSchema } from "../attachments/attachment";
export const MAX_SESSION_FILE_REFERENCES = 1000;

export const InputReferenceSchema = z.strictObject({
  inputId: z.uuid(),
  versionId: z.uuid(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type InputReference = z.infer<typeof InputReferenceSchema>;

export const InputUploadSchema = z.strictObject({
  inputId: z.uuid(),
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type InputUpload = z.infer<typeof InputUploadSchema>;

export const InputObjectSchema = z.strictObject({
  sessionId: z.uuid(),
  reference: InputReferenceSchema,
  state: z.enum(["uploading", "ready", "rejected", "expired"]),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type InputObject = z.infer<typeof InputObjectSchema>;

export const ExportObjectSchema = z.strictObject({
  exportId: z.uuid(),
  sessionId: z.uuid(),
  requestId: z.uuid(),
  versionId: z.uuid(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completeness: z.enum(["complete", "partial"]),
  availability: z.enum(["published", "expired", "unavailable"]),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ExportObject = z.infer<typeof ExportObjectSchema>;
