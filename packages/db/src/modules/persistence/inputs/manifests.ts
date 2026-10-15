import { AcceptedInputManifestSchema, ApiError, canonicalJson, digestOf } from "@pstdio/pocketcoder-contracts";
import type { InputManifestRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../../database/context";
import { requiredRow } from "../../../database/required-row";
import { lockStorageCapacity } from "../reservation-capacity";
import { inputKey, readInput } from "./objects";
import { inputIsPinned } from "./pins";

export function createInputManifests(context: DatabaseContext) {
  const {
    db,
    tables: { inputObjects: objects, inputManifests: manifests, storageReservations: reservations, workspaces },
  } = context;
  return {
    freeze(id: string, workspaceId: string, incarnationId: string, fileIds: string[], at: Date) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [existing] = await tx.select().from(manifests).where(eq(manifests.id, id));
        if (existing) return frozenRetry(existing, workspaceId, incarnationId, fileIds);
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
        if (!workspace || workspace.terminalAt || workspace.purgeRequestedAt || workspace.deadlineAt <= at)
          throw new Error("Input manifest workspace authority is invalid.");
        const selected = [];
        for (const fileId of fileIds) {
          const row = await readInput(context, tx, workspaceId, fileId);
          if (
            row?.state !== "ready" ||
            (row.retainedUntil <= at && !(await inputIsPinned(context, tx, workspaceId, fileId)))
          )
            throw new ApiError("attachment.not_found", "Input is unavailable or expired.");
          selected.push(row.reference);
        }
        const contents = { workspaceId, incarnationId, objects: selected };
        const manifest = AcceptedInputManifestSchema.parse({ ...contents, digest: digestOf(contents) });
        const [row] = await tx.insert(manifests).values({ id, manifest, finalizedAt: null }).returning();
        return requiredRow(row);
      });
    },
    async getManifest(id: string) {
      const [row] = await db.select().from(manifests).where(eq(manifests.id, id));
      return row ?? null;
    },
    async finalize(id: string, at: Date) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [row] = await tx.select().from(manifests).where(eq(manifests.id, id));
        if (!row || row.finalizedAt) return;
        for (const object of row.manifest.objects) {
          const stored = requiredRow(await readInput(context, tx, object.workspaceId, object.fileId));
          await tx
            .update(objects)
            .set({ retainedUntil: new Date(at.getTime() + stored.retentionMs) })
            .where(inputKey(context, object.workspaceId, object.fileId));
        }
        await tx.update(manifests).set({ finalizedAt: at }).where(eq(manifests.id, id));
      });
    },
    beginRelease(workspaceId: string, fileId: string, reservationId: string, at: Date) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const row = requiredRow(await readInput(context, tx, workspaceId, fileId));
        if (row.reservationId !== reservationId || row.state === "expired") return false;
        if (await inputIsPinned(context, tx, workspaceId, fileId)) return false;
        if (row.state === "uploading" && row.transferExpiresAt > at) return false;
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
        if (["ready", "unavailable"].includes(row.state) && row.retainedUntil > at && !workspace?.purgeRequestedAt)
          return false;
        await tx
          .update(objects)
          .set({ state: "releasing" })
          .where(inputKey(context, workspaceId, fileId));
        await tx
          .update(reservations)
          .set({ state: "releasing", updatedAt: at })
          .where(eq(reservations.id, row.reservationId));
        return true;
      });
    },
    async release(workspaceId: string, fileId: string, reservationId: string) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const row = requiredRow(await readInput(context, tx, workspaceId, fileId));
        if (row.reservationId !== reservationId || row.state !== "releasing")
          throw new Error("Input must be removed before release.");
        await tx
          .update(objects)
          .set({ state: "expired", reference: { ...row.reference, visibility: "expired" } })
          .where(inputKey(context, workspaceId, fileId));
        await tx
          .update(reservations)
          .set({
            state: "released",
            reservedBytes: 0,
            reservedFiles: 0,
            materializedBytes: 0,
            materializedFiles: 0,
            releasedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(reservations.id, row.reservationId), eq(reservations.state, "releasing")));
      });
    },
  };
}

function frozenRetry(existing: InputManifestRow, workspaceId: string, incarnationId: string, fileIds: string[]) {
  if (
    existing.manifest.workspaceId !== workspaceId ||
    existing.manifest.incarnationId !== incarnationId ||
    canonicalJson(existing.manifest.objects.map((object) => object.fileId)) !== canonicalJson(fileIds) ||
    existing.finalizedAt
  )
    throw new ApiError("attachment.conflict", "Input manifest is already frozen.");
  return existing;
}
