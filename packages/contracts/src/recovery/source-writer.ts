import { z } from "zod";

const fileIdentity = z.strictObject({
  device: z.string().regex(/^\d+$/).max(20),
  inode: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(20),
});

export const SourceWriterSchema = z.strictObject({
  format: z.literal("pocketcoder-source-writer/v1"),
  directory: z.string().startsWith("/").max(4096),
  root: fileIdentity,
  lock: fileIdentity,
});
export type SourceWriter = z.infer<typeof SourceWriterSchema>;
