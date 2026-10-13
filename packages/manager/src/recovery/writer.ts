import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { ObjectStorageError, readPrivateFile, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import type { ManagerContext } from "../database/context";
import type { PurgeAuthority } from "../purge/authority";

const ClaimSchema = z.strictObject({
  journalId: z.uuid(),
  generation: z.number().int().nonnegative(),
  writer: SourceWriterSchema,
});
export const InstallationSchema = ClaimSchema.extend({
  recoveryOperationId: z.uuid().optional(),
  recoveryReceiptDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const recoveryReceiptDigest = (receipt: unknown) =>
  createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
export const installationPath = (directory: string) => join(directory, "MANAGER.json");
const claimKey = (claim: z.infer<typeof ClaimSchema>) => `manager/writers/${claim.journalId}/${claim.generation}.json`;

export async function currentManagerWriter(authority: PurgeAuthority) {
  const journalId = authority.journal.head().journalId;
  const prefix = `manager/writers/${journalId}/`;
  const entries = (await authority.storage.versions(prefix)).filter((entry) => entry.latest);
  if (entries.some((entry) => entry.deleted)) throw new Error("Manager writer evidence was deleted.");
  if (!entries.length) return null;
  const claims = [];
  for (const entry of entries) {
    const claim = ClaimSchema.parse(await (await authority.storage.get(entry.key, entry.versionId)).json());
    if (claim.journalId !== journalId || claimKey(claim) !== entry.key)
      throw new Error("Manager writer identity differs.");
    claims.push(claim);
  }
  claims.sort((left, right) => left.generation - right.generation);
  if (claims.some((claim, index) => claim.generation !== index))
    throw new Error("Manager writer history is incomplete.");
  return claims.at(-1) ?? null;
}
async function publish(authority: PurgeAuthority, claim: z.infer<typeof ClaimSchema>) {
  try {
    await authority.storage.putIfAbsent(claimKey(claim), Buffer.from(JSON.stringify(claim)));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
  }
  if (!isDeepStrictEqual(await currentManagerWriter(authority), claim))
    throw new Error("Manager writer transfer was not acknowledged.");
}
export async function bindManagerWriter(context: ManagerContext, authority: PurgeAuthority) {
  const writer = context.sourceWriter();
  if (!writer) throw new Error("Manager backup requires a durable writer.");
  const current = await currentManagerWriter(authority);
  if (current && !isDeepStrictEqual(current.writer, writer))
    throw new Error("Manager writer belongs to another installation; recovery is required.");
  const claim = current ?? { journalId: authority.journal.head().journalId, generation: 0, writer };
  await publish(authority, claim);
  await context.db
    .insert(context.tables.installation)
    .values({ id: 1, journalId: claim.journalId })
    .onConflictDoNothing();
  const marker = installationPath(writer.directory);
  const retained = existsSync(marker)
    ? InstallationSchema.parse(JSON.parse((await readPrivateFile(marker, 65_536)).toString()))
    : claim;
  await writePrivateJson(marker, retained, 65_536);
  return claim;
}
export async function assertManagerInstallation(context: ManagerContext, authority?: PurgeAuthority) {
  const directory = context.directory;
  if (!directory) return;
  if (existsSync(join(directory, "RECOVERY.json"))) throw new Error("Manager recovery must complete before admission.");
  const [binding] = await context.db.select().from(context.tables.installation);
  const hasMarker = existsSync(installationPath(directory));
  if (!authority) {
    if (binding || hasMarker) throw new Error("Manager recovery requires its independent journal configuration.");
    return;
  }
  if (binding && binding.journalId !== authority.journal.head().journalId)
    throw new Error("Manager recovery journal identity differs.");
  const current = await currentManagerWriter(authority);
  if (!current) {
    if (binding || hasMarker) throw new Error("Manager recovery writer evidence is missing.");
    return;
  }
  if (!isDeepStrictEqual(current.writer, context.sourceWriter()))
    throw new Error("Manager recovery writer was replaced or belongs to another installation.");
  if (!hasMarker) return;
  const local = InstallationSchema.parse(
    JSON.parse((await readPrivateFile(installationPath(directory), 65_536)).toString()),
  );
  const { recoveryOperationId: _, recoveryReceiptDigest: __, ...claim } = local;
  if (!isDeepStrictEqual(current, claim)) throw new Error("Manager recovery writer evidence differs.");
}
export async function transferManagerWriter(
  context: ManagerContext,
  authority: PurgeAuthority,
  operationId: string,
  receipt: unknown,
) {
  const previous = await currentManagerWriter(authority);
  const writer = context.sourceWriter();
  if (!previous || !writer) throw new Error("Manager recovery source writer evidence is missing.");
  if (isDeepStrictEqual(previous.writer, writer)) {
    await writePrivateJson(
      installationPath(writer.directory),
      { ...previous, recoveryOperationId: operationId, recoveryReceiptDigest: recoveryReceiptDigest(receipt) },
      65_536,
    );
    return;
  }
  // Holding the original installation's kernel lock proves its manager is stopped during transfer.
  if (!lstatSync(previous.writer.directory).isDirectory()) throw new Error("Manager recovery source identity differs.");
  const source = lockDataFolder(previous.writer.directory);
  try {
    if (!isDeepStrictEqual(source.sourceWriter(), previous.writer))
      throw new Error("Manager recovery source identity differs.");
    const claim = { ...previous, generation: previous.generation + 1, writer };
    await publish(authority, claim);
    await writePrivateJson(
      installationPath(writer.directory),
      { ...claim, recoveryOperationId: operationId, recoveryReceiptDigest: recoveryReceiptDigest(receipt) },
      65_536,
    );
    await writePrivateJson(join(source.dir, "RETIRED"), { operationId, destination: writer.directory }, 65_536);
  } finally {
    source.close();
  }
}
