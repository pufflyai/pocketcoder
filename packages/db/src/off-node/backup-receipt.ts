import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { JournalCursorSchema } from "../journal/events";
import { RuntimeIdentitySchema } from "./runtime-identity";
import { StagingFootprintSchema } from "./staging-capacity";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const OffNodeBackupReceiptSchema = z.strictObject({
  accountId: z.uuid(),
  operationId: z.uuid(),
  snapshotId: z.uuid(),
  createdAt: z.iso.datetime(),
  plaintextDigest: digest,
  journal: JournalCursorSchema,
  sourceWriter: SourceWriterSchema,
  runtimes: z.array(RuntimeIdentitySchema),
  staging: z.strictObject({
    reservationId: z.uuid(),
    archiveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contents: StagingFootprintSchema,
    database: StagingFootprintSchema,
  }),
  object: z.strictObject({
    key: z.string().min(1),
    versionId: z.string().min(1),
    etag: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    digest,
  }),
});
export type OffNodeBackupReceipt = z.infer<typeof OffNodeBackupReceiptSchema>;

export async function digestFile(path: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, digest: `sha256:${hash.digest("hex")}` };
}

export async function digestResponse(response: Response) {
  if (!response.body) throw new Error("Off-node object has no body.");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, digest: `sha256:${hash.digest("hex")}` };
}
