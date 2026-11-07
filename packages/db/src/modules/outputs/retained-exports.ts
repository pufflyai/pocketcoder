import {
  ApiError,
  canonicalJson,
  executionInputManifestId,
  type WorkloadExportReference,
  WorkloadExportReferenceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { RetainedExportStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { lockExecutionSession, readExecution, writeExecution } from "../workspaces/execution-owners";
import { adapterPublication } from "./adapter-publication";
import { deleteExportBytes } from "./retained-export-capacity";

import { commitExportFiles } from "./retained-export-write";

function replayedExport(known: WorkloadExportReference | undefined, manifest: WorkloadExportReference) {
  if (!known) return null;
  const fixed = (value: WorkloadExportReference) => ({ ...value, publication: "published", cleanupState: "pending" });
  if (canonicalJson(fixed(known)) !== canonicalJson(fixed(manifest)))
    throw new ApiError("operation.conflict", "Export is immutable.");
  return known;
}

export function createRetainedExports(context: DatabaseContext): RetainedExportStore {
  const { db, tables } = context;
  const objects = tables.exportObjects;
  const store: RetainedExportStore = {
    ...adapterPublication(context, (...args) => store.commit(...args)),
    async commit(input, files, at, capacity) {
      const manifest = WorkloadExportReferenceSchema.parse(input);
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        await lockExecutionSession(context, tx, manifest.execution);
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, manifest.execution.workspaceId))
          .for("update");
        if (!workspace || workspace.purgeRequestedAt)
          throw new ApiError("operation.conflict", "Export owner unavailable.");
        const record = await readExecution(context, tx, workspace, manifest.execution);
        if (!record) throw new ApiError("operation.conflict", "Export execution was not accepted.");
        const known = replayedExport(record.collection, manifest);
        if (known) return known;
        if (!["terminal", "canceled", "lost", "unknown"].includes(record.phase))
          throw new ApiError("operation.conflict", "Export execution is not settled.");
        await commitExportFiles(context, tx, workspace, manifest, files, at, capacity);
        if (manifest.execution.owner === "process")
          await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
        await writeExecution(context, tx, {
          ...record,
          collection: manifest,
          ...(manifest.execution.owner === "process" ? { finalizedAt: at.toISOString() } : {}),
        });
        return manifest;
      });
    },
    async completeCleanup(execution) {
      await db.transaction(async (tx) => {
        await lockExecutionSession(context, tx, execution);
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
        .select({ data: objects.data, execution: objects.execution })
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
      const workspace = (await db.select().from(tables.workspaces).where(eq(tables.workspaces.id, workspaceId)))[0];
      if (!row || !workspace) return null;
      const record = await readExecution(context, db, workspace, row.execution);
      return record?.collection?.objects.some((object) => object.objectId === objectId) ? row.data : null;
    },
    async delete(execution, exportId, principalId, at) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        await lockExecutionSession(context, tx, execution);
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
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const expired = await tx.select().from(objects).where(lte(objects.expiresAt, at));
        for (const object of expired) {
          if (object.reservationId && object.exportId === object.reservationId) continue;
          await deleteExportBytes(context, tx, eq(objects.id, object.id), at);
        }
      });
    },
  };
  return store;
}
