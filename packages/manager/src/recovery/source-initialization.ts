import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivateFile, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import type { z } from "zod";
import type { ManagerContext } from "../database/context";
import type { PurgeAuthority } from "../purge/authority";
import { canonicalSourceWriter, type SourceBinding, type verifySource } from "./source-binding";
import {
  immutableSourceRecord,
  persistSourceProgress,
  recheckSourceTarget,
  SourceProgressSchema,
} from "./source-transfer";
import { ClaimSchema, installationPath, publishManagerWriter, recoveryReceiptDigest } from "./writer";

export async function initializeManagerSource(
  context: ManagerContext,
  authority: PurgeAuthority,
  current: z.infer<typeof ClaimSchema> | null,
  verified: Awaited<ReturnType<typeof verifySource>>,
) {
  if (!context.directory || !authority.sourceConfig) throw new Error("Manager physical initialization is unavailable.");
  const observed = context.sourceWriter();
  if (!observed) throw new Error("Manager source lock is missing.");
  const journalId = authority.journal.head().journalId;
  const intendedPath = join(authority.dependencies.directory, "source-initial.json");
  const intended = existsSync(intendedPath)
    ? ClaimSchema.parse(JSON.parse((await readPrivateFile(intendedPath, 65536)).toString()))
    : null;
  if (current && (!intended || !isDeepStrictEqual(current, intended)))
    throw new Error("Manager initial intended claim is missing or differs.");
  const claim = initialSourceClaim(journalId, verified.binding, observed, verified.blockDevice, intended);
  if (!intended) {
    authority.dependencies.validate();
    await writePrivateJson(intendedPath, claim, 65536);
    authority.dependencies.validate();
  }
  const progressPath = join(authority.dependencies.directory, "source-transfer.json");
  const markerPath = installationPath(context.directory);
  const claimDigest = recoveryReceiptDigest(claim);
  const progress = existsSync(progressPath)
    ? SourceProgressSchema.parse(JSON.parse((await readPrivateFile(progressPath, 65536)).toString()))
    : undefined;
  if (current && !progress) throw new Error("Manager physical initialization progress is missing.");
  if (!current && existsSync(markerPath))
    throw new Error("Manager physical initialization cannot replace an existing marker.");
  if (progress && (progress.operationId !== journalId || progress.claimDigest !== claimDigest))
    throw new Error("Manager physical initialization has another owner.");
  if (progress?.state === "complete") return claim;
  await persistSourceProgress(authority, progressPath, { operationId: journalId, claimDigest, state: "pending" });
  await immutableSourceRecord(authority, `manager/source-transfers/${journalId}/prepare.json`, { initialClaim: claim });
  await publishManagerWriter(authority, claim);
  await recheckSourceTarget(context, authority.sourceConfig, verified, claim);
  await immutableSourceRecord(authority, `manager/source-transfers/${journalId}/complete.json`, {
    operationId: journalId,
    claimDigest,
  });
  context.validate();
  await writePrivateJson(markerPath, claim, 65536);
  context.validate();
  await persistSourceProgress(authority, progressPath, { operationId: journalId, claimDigest, state: "complete" });
  return claim;
}

export function requireInitialPreparation(claim: z.infer<typeof ClaimSchema>, value: unknown) {
  if (
    !claim.sourceBinding ||
    claim.generation !== 0 ||
    claim.sourceTransfer !== claim.journalId ||
    !isDeepStrictEqual(value, { initialClaim: claim })
  )
    throw new Error("Manager source initialization lineage differs.");
}

export function initialSourceClaim(
  journalId: string,
  binding: SourceBinding,
  observed: z.infer<typeof ClaimSchema>["writer"],
  blockDevice: string,
  intended: z.infer<typeof ClaimSchema> | null,
) {
  const claim = intended ?? {
    journalId,
    generation: 0,
    writer: observed,
    sourceBinding: binding,
    sourceTransfer: journalId,
  };
  if (
    claim.journalId !== journalId ||
    claim.generation !== 0 ||
    claim.sourceTransfer !== journalId ||
    !isDeepStrictEqual(claim.sourceBinding, binding)
  )
    throw new Error("Manager physical initialization identity differs.");
  canonicalSourceWriter(claim.writer, observed, blockDevice);
  return claim;
}
