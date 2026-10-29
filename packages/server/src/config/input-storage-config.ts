import { WorkloadImageSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const bound = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const InputStorageConfigSchema = z.strictObject({
  root: z.string().min(1),
  projection: z
    .strictObject({
      root: z.string().min(1),
      probeImage: WorkloadImageSchema,
      capacity: z.strictObject({ bytes: bound, files: bound }),
    })
    .optional(),
  limits: z.strictObject({
    fileBytes: bound,
    stagedBytes: bound,
    files: bound,
    transfers: bound,
    transferMs: bound,
    retentionMs: bound,
  }),
  principal: z.strictObject({ bytes: bound, files: bound }),
  instance: z.strictObject({ bytes: bound, files: bound }),
  headroom: z.strictObject({ bytes: bound, files: bound }),
});
export type InputStorageConfig = z.infer<typeof InputStorageConfigSchema>;
export function inputStorageConfig(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const config = InputStorageConfigSchema.parse(JSON.parse(raw));
  if (
    config.limits.fileBytes > config.limits.stagedBytes ||
    config.limits.stagedBytes > config.principal.bytes ||
    config.principal.bytes > config.instance.bytes ||
    config.limits.files > config.principal.files ||
    config.principal.files > config.instance.files
  )
    throw new Error("Input limits must fit within the deployment capacity.");
  return config;
}
