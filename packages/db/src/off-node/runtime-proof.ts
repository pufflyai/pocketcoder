import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { RuntimeIdentitySchema } from "./runtime-identity";

export const RuntimeTerminationSchema = z.strictObject({
  identity: RuntimeIdentitySchema,
  termination: z.record(z.string(), z.unknown()),
});
export const BackupRuntimeProofSchema = z.strictObject({
  accountId: z.uuid(),
  operationId: z.uuid(),
  snapshotId: z.uuid(),
  plaintextDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceWriter: SourceWriterSchema,
  runtimes: z.array(RuntimeTerminationSchema),
});
export type BackupRuntimeProof = z.infer<typeof BackupRuntimeProofSchema>;
