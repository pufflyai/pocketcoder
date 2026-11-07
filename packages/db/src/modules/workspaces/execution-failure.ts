import {
  ApiError,
  canonicalJson,
  digestOf,
  type ExecutionRecord,
  executionInputManifestId,
  type WorkloadExportReference,
} from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { writeExecution } from "./execution-owners";

function finalOutcome(record: ExecutionRecord, reason: string, lost: boolean) {
  if (["terminal", "canceled"].includes(record.phase)) return { phase: record.phase, outcome: record.outcome };
  if (lost) return { phase: "lost" as const, outcome: { status: "lost", reasonCode: reason } };
  return { phase: "terminal" as const, outcome: { status: "failed", reasonCode: reason } };
}

// Only for proved-unsent work or a generation whose provider has been fenced.
export async function settleExecutionFailure(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  reason: string,
  at: Date,
  lost = false,
) {
  const execution = record.acceptance.execution;
  const objects = context.tables.exportObjects;
  const staged = lost
    ? (await tx.select().from(objects).where(eq(objects.workspaceId, execution.workspaceId))).filter(
        (row) => canonicalJson(row.execution) === canonicalJson(execution),
      )
    : [];
  const core: Pick<WorkloadExportReference, "execution" | "objects" | "completeness" | "errors"> = {
    execution,
    objects: staged.map((row) => row.reference),
    completeness: staged.length ? ("partial" as const) : ("lost" as const),
    errors: [reason],
  };
  const [workspace] = await tx
    .select()
    .from(context.tables.workspaces)
    .where(eq(context.tables.workspaces.id, execution.workspaceId));
  const retention = workspace?.runtimeRegistration?.template?.manifest.spec.limits.exportRetentionSeconds;
  if (!retention) throw new ApiError("operation.conflict", "Retained result limits are unavailable.");
  const preserve = ["terminal", "canceled"].includes(record.phase);
  const expected =
    workspace?.runtimeRegistration?.template?.manifest.spec.operations[record.acceptance.operation]?.outputRoots.length;
  if (record.publicationComplete || (preserve && expected === 0)) {
    core.completeness = "complete";
    core.errors = [];
  }
  const cleanupRequired = lost || (record.dispatchClaimedAt !== null && record.acceptance.inputs.objects.length > 0);
  const collection: WorkloadExportReference = record.collection
    ? { ...record.collection, cleanupState: cleanupRequired ? "pending" : record.collection.cleanupState }
    : {
        ...core,
        exportId: executionInputManifestId(record.acceptance),
        manifestDigest: digestOf(core),
        publication: "published",
        publishedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + retention * 1000).toISOString(),
        cleanupState: cleanupRequired ? "pending" : "not_required",
      };
  for (const object of staged)
    await tx
      .update(objects)
      .set({ exportId: collection.exportId, expiresAt: new Date(collection.expiresAt) })
      .where(eq(objects.id, object.id));
  await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
  const next: ExecutionRecord = {
    ...record,
    ...finalOutcome(record, reason, lost),
    settledAt: record.settledAt ?? at.toISOString(),
    finalizedAt: at.toISOString(),
    finalizationBasis: lost ? "runtime_fenced" : "never_sent",
    collection,
  };
  await writeExecution(context, tx, next);
  return next;
}
