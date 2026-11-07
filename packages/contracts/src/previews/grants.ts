import { z } from "zod";
import { PreviewNameSchema } from "./preview";

export const PreviewGrantCreateSchema = z.strictObject({
  id: z.uuid(),
  subject: z.string().min(1).max(256),
  accessRevision: z.string().min(1).max(256),
  previews: z
    .array(PreviewNameSchema)
    .min(1)
    .max(16)
    .refine((names) => new Set(names).size === names.length, "Preview names must be unique"),
  ceilingAt: z.iso.datetime(),
});
export const PreviewGrantRenewSchema = z.strictObject({ accessRevision: z.string().min(1).max(256) });
export const PREVIEW_AUTHORIZATION_CHECK_MS = 250;
export const PREVIEW_GRANT_LEASE_MS = 60_000;
