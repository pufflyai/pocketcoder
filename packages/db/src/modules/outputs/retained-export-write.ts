import {
  ApiError,
  canonicalJson,
  sha256Hex,
  type WorkloadExportReference,
  type WorkloadLimits,
} from "@pstdio/pocketcoder-contracts";
import type { RetainedExportStore, StorageCapacity, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { managedExecutionOwner } from "../workspaces/execution-owners";
import { reserveExport } from "./retained-export-capacity";

function verifiedFiles(
  manifest: WorkloadExportReference,
  files: Parameters<RetainedExportStore["commit"]>[1],
  limits?: WorkloadLimits,
) {
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (
    !limits ||
    files.length > limits.exportFiles ||
    total > limits.exportBytes ||
    files.length !== manifest.objects.length
  )
    throw new ApiError("operation.conflict", "Export exceeds its declared bounds.");
  if (Date.parse(manifest.expiresAt) - Date.parse(manifest.publishedAt) > limits.exportRetentionSeconds * 1000)
    throw new ApiError("operation.conflict", "Export exceeds its retention ceiling.");
  return manifest.objects.map((object) => {
    const file = files.find((file) => file.objectId === object.objectId);
    if (
      !file ||
      object.sizeBytes !== file.bytes.length ||
      object.digest !== `sha256:${sha256Hex(file.bytes)}` ||
      object.objectVersion !== object.digest
    )
      throw new ApiError("operation.conflict", "Export content does not match its immutable reference.");
    return { object, bytes: file.bytes };
  });
}

export async function commitExportFiles(
  context: DatabaseContext,
  tx: Transaction,
  workspace: WorkspaceRow,
  manifest: WorkloadExportReference,
  files: Parameters<RetainedExportStore["commit"]>[1],
  at: Date,
  capacity?: StorageCapacity,
) {
  const { tables } = context;
  const objects = tables.exportObjects;
  const limits = workspace.runtimeRegistration?.template?.manifest.spec.limits;
  const staged = (await tx.select().from(objects).where(eq(objects.workspaceId, workspace.id))).filter(
    (row) => row.reservationId && canonicalJson(row.execution) === canonicalJson(manifest.execution),
  );
  if (!staged.length) await reserveExport(context, tx, manifest, workspace.principalId, at, capacity);
  else if (
    staged.length !== manifest.objects.length ||
    staged.some(
      (row) =>
        !manifest.objects.some(
          (object) => object.objectId === row.id && canonicalJson(object) === canonicalJson(row.reference),
        ),
    )
  )
    throw new ApiError("operation.conflict", "Publication selection changed.");
  const owner = await managedExecutionOwner(context, tx, manifest.execution);
  for (const { object, bytes } of verifiedFiles(manifest, files, limits)) {
    if (staged.length) {
      await tx
        .update(objects)
        .set({ exportId: manifest.exportId, expiresAt: new Date(manifest.expiresAt) })
        .where(eq(objects.id, object.objectId));
      continue;
    }
    await tx.insert(objects).values({
      id: object.objectId,
      exportId: manifest.exportId,
      workspaceId: workspace.id,
      principalId: workspace.principalId,
      sessionId: owner?.conversationId,
      execution: manifest.execution,
      reference: object,
      data: Buffer.from(bytes),
      expiresAt: new Date(manifest.expiresAt),
    });
  }
}
