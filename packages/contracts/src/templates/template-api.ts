import { z } from "zod";
import { TemplateManifestSchema } from "./template";

export const TemplatePublishRequestSchema = z.strictObject({ manifest: TemplateManifestSchema });

export const TemplateVersionParamsSchema = z.object({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  version: z.string().min(1).max(256),
});
