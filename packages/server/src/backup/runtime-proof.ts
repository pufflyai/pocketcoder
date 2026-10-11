import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isTerminal } from "@pstdio/pocketcoder-contracts";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import {
  BackupRuntimeProofSchema,
  type OffNode,
  OffNodeBackupReceiptSchema,
  type RuntimeIdentity,
  readPrivateFile,
  runtimeIdentity,
} from "@pstdio/pocketcoder-db/off-node";
import { hasMatchingKubernetesTermination } from "@pstdio/pocketcoder-drivers";

export async function runtimeRow(store: PGliteStore, identity: RuntimeIdentity) {
  const row =
    identity.kind === "workspace" ? await store.getWorkspace(identity.id) : await store.getWarmPoolRuntime(identity.id);
  if (!row?.providerRef) throw new Error("Archived runtime source row is missing.");
  const provider = "providerKind" in row ? row.providerKind : row.driverKind;
  if (!isDeepStrictEqual(runtimeIdentity(identity.kind, identity.id, provider, row.providerRef), identity))
    throw new Error("Archived runtime provider identity differs.");
  return row;
}

export function requireRuntimeTermination(identity: RuntimeIdentity, termination: Record<string, unknown>) {
  if (
    identity.provider !== "kubernetes" ||
    identity.ref.kind !== "kubernetes" ||
    !hasMatchingKubernetesTermination(identity.ref, termination)
  )
    throw new Error("Archived runtime termination identity is unproved.");
}

export async function capturedRuntimeProof(store: PGliteStore, offNode: OffNode, operationId: string) {
  const receipt = OffNodeBackupReceiptSchema.parse(
    JSON.parse(
      (await readPrivateFile(join(offNode.directory, "operations", operationId, "receipt.json"), 65_536)).toString(),
    ),
  );
  if (
    receipt.accountId !== offNode.config.accountId ||
    receipt.operationId !== operationId ||
    !isDeepStrictEqual(receipt.sourceWriter, store.journalSnapshot().writer)
  )
    throw new Error("Archived runtime source writer differs.");
  const runtimes = [];
  for (const identity of receipt.runtimes) {
    const row = await runtimeRow(store, identity);
    if (
      identity.kind === "workspace"
        ? !isTerminal(row.state as Parameters<typeof isTerminal>[0])
        : row.state !== "failed"
    )
      throw new Error("Archived runtime source is still active.");
    const termination = row.providerRef?.terminationEvidence as Record<string, unknown> | undefined;
    if (!termination) throw new Error("Archived runtime termination proof is missing.");
    requireRuntimeTermination(identity, termination);
    runtimes.push({ identity, termination });
  }
  return BackupRuntimeProofSchema.parse({
    accountId: receipt.accountId,
    operationId,
    snapshotId: receipt.snapshotId,
    plaintextDigest: receipt.plaintextDigest,
    sourceWriter: receipt.sourceWriter,
    runtimes,
  });
}
