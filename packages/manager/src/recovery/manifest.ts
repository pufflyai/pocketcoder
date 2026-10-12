import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { StagingFootprintSchema } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import seed from "../../assets/manager-seed.json" with { type: "json" };
import migrations from "../../assets/migrations.json" with { type: "json" };
import { ManagerCursorSchema } from "./journal";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const MemberSchema = z.discriminatedUnion("type", [
  z.strictObject({ path: z.string(), type: z.literal("directory") }),
  z.strictObject({ path: z.string(), type: z.literal("file"), bytes: integer, digest }),
]);
export const ManagerManifestSchema = z.strictObject({
  format: z.literal("pocketcoder-manager-backup/v1"),
  app: z.literal("pocketcoder-manager"),
  operationId: z.uuid(),
  createdAt: z.iso.datetime(),
  engine: z.literal("18"),
  pgliteVersion: z.string(),
  seedChecksum: z.string(),
  migrations: z.array(z.strictObject({ name: z.string(), hash: z.string() })),
  journal: ManagerCursorSchema,
  sourceWriter: SourceWriterSchema,
  inventory: z.array(
    z.strictObject({ id: z.uuid(), namespace: z.string(), state: z.string(), operations: z.array(z.uuid()) }),
  ),
  members: z.array(MemberSchema),
});
export const ManagerReceiptSchema = z.strictObject({
  format: z.literal("pocketcoder-manager-receipt/v1"),
  operationId: z.uuid(),
  createdAt: z.iso.datetime(),
  journal: ManagerCursorSchema,
  sourceWriter: SourceWriterSchema,
  plaintext: z.strictObject({ bytes: integer, digest }),
  footprint: StagingFootprintSchema,
  object: z.strictObject({
    key: z.string(),
    versionId: z.string().min(1),
    etag: z.string().min(1),
    bytes: integer,
    digest,
  }),
});
export type ManagerReceipt = z.infer<typeof ManagerReceiptSchema>;
export const currentFormat = {
  app: "pocketcoder-manager" as const,
  engine: "18" as const,
  pgliteVersion: seed.pgliteVersion,
  seedChecksum: seed.checksum,
  migrations: migrations.map(({ name, hash }) => ({ name, hash })),
};
export function requireManagerFormat(manifest: z.infer<typeof ManagerManifestSchema>) {
  for (const [key, value] of Object.entries(currentFormat))
    if (JSON.stringify(manifest[key as keyof typeof currentFormat]) !== JSON.stringify(value))
      throw new Error("Manager backup format, engine, seed or schema differs from this release.");
}
