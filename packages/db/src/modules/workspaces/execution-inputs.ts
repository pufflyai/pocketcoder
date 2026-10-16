import { canonicalJson, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
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
    const object = await readInput(context, tx, input.execution.workspaceId, reference.fileId);
    if (
      !object ||
      object.principalId !== input.callerPrincipalId ||
      object.state !== "ready" ||
      canonicalJson(object.reference) !== canonicalJson(reference)
    )
      executionConflict("Exact input object is unavailable.");
    if (object.retainedUntil <= at && !(await inputIsPinned(context, tx, reference.workspaceId, reference.fileId)))
      executionConflict("Exact input object has expired.");
  }
  const manifests = context.tables.inputManifests;
  const [manifest] = await tx.select().from(manifests).where(eq(manifests.id, input.execution.requestId));
  if (manifest && (manifest.finalizedAt || canonicalJson(manifest.manifest) !== canonicalJson(input.inputs)))
    executionConflict("Input manifest conflict.");
  if (!manifest)
    await tx.insert(manifests).values({ id: input.execution.requestId, manifest: input.inputs, finalizedAt: null });
}

export async function requireExecutionInputs(context: DatabaseContext, tx: Transaction, input: WorkloadAcceptance) {
  const manifests = context.tables.inputManifests;
  const [manifest] = await tx.select().from(manifests).where(eq(manifests.id, input.execution.requestId));
  if (!manifest || manifest.finalizedAt || canonicalJson(manifest.manifest) !== canonicalJson(input.inputs))
    executionConflict("Accepted input pin is no longer available.");
  for (const reference of input.inputs.objects) {
    const object = await readInput(context, tx, input.execution.workspaceId, reference.fileId);
    if (object?.state !== "ready" || canonicalJson(object.reference) !== canonicalJson(reference))
      executionConflict("Accepted input bytes are no longer available.");
  }
}
