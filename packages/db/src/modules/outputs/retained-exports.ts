import {
  ApiError,
  canonicalJson,
  executionInputManifestId,
  sha256Hex,
  type WorkloadExportReference,
  WorkloadExportReferenceSchema,
  type WorkloadLimits,
} from "@pstdio/pocketcoder-contracts";
import type { RetainedExportStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { readExecution, writeExecution } from "../workspaces/execution-owners";
import { deleteExportBytes, reserveExport } from "./retained-export-capacity";

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

export function createRetainedExports(context: DatabaseContext): RetainedExportStore {
  const { db, tables } = context;
  const objects = tables.exportObjects;
  return {
    async commit(input, files, at, capacity) {
      const manifest = WorkloadExportReferenceSchema.parse(input);
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, manifest.execution.workspaceId))
          .for("update");
        if (!workspace || workspace.purgeRequestedAt)
          throw new ApiError("operation.conflict", "Export owner unavailable.");
        const record = await readExecution(context, tx, workspace, manifest.execution);
        if (!record) throw new ApiError("operation.conflict", "Export execution was not accepted.");
        if (record.collection) {
          if (
            canonicalJson({ ...record.collection, publication: "published", cleanupState: "pending" }) !==
            canonicalJson({ ...manifest, publication: "published", cleanupState: "pending" })
          )
            throw new ApiError("operation.conflict", "Export is immutable.");
          return record.collection;
        }
        if (!["terminal", "canceled", "lost", "unknown"].includes(record.phase))
          throw new ApiError("operation.conflict", "Export execution is not settled.");
        const limits = workspace.runtimeRegistration?.template?.manifest.spec.limits;
        await reserveExport(context, tx, manifest, workspace.principalId, at, capacity);
        for (const { object, bytes } of verifiedFiles(manifest, files, limits)) {
          await tx.insert(objects).values({
            id: object.objectId,
            exportId: manifest.exportId,
            workspaceId: workspace.id,
            principalId: workspace.principalId,
            execution: manifest.execution,
            reference: object,
            data: Buffer.from(bytes),
            expiresAt: new Date(manifest.expiresAt),
          });
        }
        await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
        await writeExecution(context, tx, { ...record, collection: manifest, finalizedAt: at.toISOString() });
        return manifest;
      });
    },
    async completeCleanup(execution) {
      await db.transaction(async (tx) => {
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, execution.workspaceId))
          .for("update");
        if (!workspace || workspace.purgeRequestedAt) return;
        const record = await readExecution(context, tx, workspace, execution);
        if (record?.collection)
          await writeExecution(context, tx, {
            ...record,
            collection: { ...record.collection, cleanupState: "complete" },
          });
      });
    },
    async content(workspaceId, objectId, principalId, at) {
      const [row] = await db
        .select({ data: objects.data })
        .from(objects)
        .innerJoin(tables.workspaces, eq(objects.workspaceId, tables.workspaces.id))
        .where(
          and(
            eq(objects.id, objectId),
            eq(objects.workspaceId, workspaceId),
            eq(objects.principalId, principalId),
            isNull(objects.deletedAt),
            isNull(tables.workspaces.purgeRequestedAt),
            gt(objects.expiresAt, at),
          ),
        );
      return row?.data ?? null;
    },
    async delete(execution, exportId, principalId, at) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(and(eq(tables.workspaces.id, execution.workspaceId), eq(tables.workspaces.principalId, principalId)))
          .for("update");
        if (!workspace) throw new ApiError("workspace.not_found", "Export not found.");
        const record = await readExecution(context, tx, workspace, execution);
        const manifest = record?.collection;
        if (!manifest || manifest.exportId !== exportId) throw new ApiError("workspace.not_found", "Export not found.");
        await deleteExportBytes(context, tx, eq(objects.exportId, manifest.exportId), at);
        if (record)
          await writeExecution(context, tx, { ...record, collection: { ...manifest, publication: "unavailable" } });
      });
    },
    async prune(at) {
      await db.transaction((tx) => deleteExportBytes(context, tx, lte(objects.expiresAt, at), at));
    },
  };
}
