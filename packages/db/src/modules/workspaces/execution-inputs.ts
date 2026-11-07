import { canonicalJson, executionInputManifestId, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { readInput } from "../persistence/inputs/objects";
import { inputIsPinned } from "../persistence/inputs/pins";
import { executionConflict } from "./execution-validation";

export async function pinExecutionInputs(
  context: DatabaseContext,
  tx: Transaction,
  input: WorkloadAcceptance,
  at: Date,
) {
  for (const reference of input.inputs.objects) {
    const object = await executionInput(context, tx, input, reference);
    if (
      !object ||
      object.principalId !== input.callerPrincipalId ||
      object.state !== "ready" ||
      canonicalJson({
        ...object.reference,
        ...(reference.storageOwnerId
          ? { workspaceId: reference.workspaceId, storageOwnerId: reference.storageOwnerId }
          : {}),
      }) !== canonicalJson(reference)
    )
      executionConflict("Exact input object is unavailable.");
    if (
      object.retainedUntil <= at &&
      !(await inputIsPinned(context, tx, reference.storageOwnerId ?? reference.workspaceId, reference.fileId))
    )
      executionConflict("Exact input object has expired.");
  }
  const manifests = context.tables.inputManifests;
  const [manifest] = await tx
    .select()
    .from(manifests)
    .where(eq(manifests.id, executionInputManifestId(input)));
  if (manifest && (manifest.finalizedAt || canonicalJson(manifest.manifest) !== canonicalJson(input.inputs)))
    executionConflict("Input manifest conflict.");
  if (!manifest)
    await tx
      .insert(manifests)
      .values({ id: executionInputManifestId(input), manifest: input.inputs, finalizedAt: null });
}

export async function requireExecutionInputs(context: DatabaseContext, tx: Transaction, input: WorkloadAcceptance) {
  const manifests = context.tables.inputManifests;
  const [manifest] = await tx
    .select()
    .from(manifests)
    .where(eq(manifests.id, executionInputManifestId(input)));
  if (!manifest || manifest.finalizedAt || canonicalJson(manifest.manifest) !== canonicalJson(input.inputs))
    executionConflict("Accepted input pin is no longer available.");
  for (const reference of input.inputs.objects) {
    const object = await executionInput(context, tx, input, reference);
    if (
      object?.state !== "ready" ||
      canonicalJson({
        ...object.reference,
        ...(reference.storageOwnerId
          ? { workspaceId: reference.workspaceId, storageOwnerId: reference.storageOwnerId }
          : {}),
      }) !== canonicalJson(reference)
    )
      executionConflict("Accepted input bytes are no longer available.");
  }
}

async function executionInput(
  context: DatabaseContext,
  tx: Transaction,
  acceptance: WorkloadAcceptance,
  reference: WorkloadAcceptance["inputs"]["objects"][number],
) {
  const owner = reference.storageOwnerId ?? reference.workspaceId;
  const object = await readInput(context, tx, owner, reference.fileId);
  if (reference.storageOwnerId) {
    const rows = await tx.select().from(context.tables.conversationRequests);
    const request = rows.find(
      (row) =>
        row.principalId === acceptance.callerPrincipalId &&
        row.identity.turn_id === acceptance.execution.requestId &&
        row.managed,
    );
    if (
      !request ||
      object?.sessionId !== request.conversationId ||
      !request.managed?.input?.attachments.some(
        (ref) => ref.inputId === reference.fileId && ref.sha256 === reference.digest,
      )
    )
      executionConflict("Input does not belong to this managed request.");
  }
  return object;
}
