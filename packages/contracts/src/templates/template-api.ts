import { z } from "zod";
import { TemplateManifestSchema } from "./template";
import { WorkloadTemplateSchema } from "./workload-template";

export const TemplatePublishRequestSchema = z.strictObject({
  manifest: z.union([TemplateManifestSchema, WorkloadTemplateSchema]),
});

export const TemplateVersionParamsSchema = z.object({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  version: z.string().min(1).max(256),
});
