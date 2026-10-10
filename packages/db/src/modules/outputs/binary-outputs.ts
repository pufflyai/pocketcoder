import { createHash } from "node:crypto";
import { ApiError, SCREENSHOT_MAX_BYTES, type ScreenshotResource } from "@pstdio/pocketcoder-contracts";
import type { BinaryOutputInput, ReadStorageCapacity } from "@pstdio/pocketcoder-runtime-contracts";
import { assertAuthorityScope } from "@pstdio/pocketcoder-runtime-core";
import { and, eq, getTableColumns, gt, isNull, lte, or } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockKeyAuthority } from "../auth/authority";
import { requireContentWritable } from "../persistence/content";
import { lockStorageCapacity, reserveStorage } from "../persistence/reservation-capacity";
import { deleteBinaryOutputs, purgeBinaryOutputs } from "./binary-output-delete";
import { appendOutputTransaction } from "./repository";

export function screenshotResource(row: {
  id: string;
  workspaceId: string;
  bytes: number | null;
  digest: string | null;
  retainedUntil: Date;
}) {
  if (!row.bytes || !row.digest) throw new Error("Screenshot has not been published.");
  return {
    kind: "screenshot",
    id: row.id,
    workspace_id: row.workspaceId,
    content_type: "image/png",
    bytes: row.bytes,
    digest: row.digest,
    expires_at: row.retainedUntil.toISOString(),
  } satisfies ScreenshotResource;
}

export function createBinaryOutputs(context: DatabaseContext) {
  const { db, tables } = context;
  const outputs = tables.binaryOutputs;
  const { data: _data, ...columns } = getTableColumns(outputs);
  async function authorize(
    tx: Transaction,
    row: Pick<
      BinaryOutputInput,
      "workspaceId" | "principalId" | "keyId" | "expiresAt" | "retainedUntil" | "connectionEpoch"
    >,
  ) {
    await requireContentWritable(tx, tables, row.workspaceId);
    const [workspace] = await tx.select().from(tables.workspaces).where(eq(tables.workspaces.id, row.workspaceId));
    const { authority } = await lockKeyAuthority(tx, tables, row.keyId);
    assertAuthorityScope(authority, "display:view");
    if (
      !workspace ||
      workspace.principalId !== row.principalId ||
      authority.principalId !== row.principalId ||
      workspace.state !== "ready" ||
      workspace.connectionEpoch !== row.connectionEpoch
    )
      throw new ApiError("operation.conflict", "Screenshot workspace authority changed.");
    if (!authority.templateNames.includes("*") && !authority.templateNames.includes(workspace.templateSnapshot.name))
      throw new ApiError("auth.missing_scope", "Screenshot template access was removed.");
    if (row.expiresAt <= new Date() || row.retainedUntil <= new Date() || workspace.deadlineAt <= new Date())
      throw new ApiError("operation.conflict", "Screenshot capture expired.");
  }
  return {
    begin(input: BinaryOutputInput, capacity: ReadStorageCapacity, check: () => void) {
      return db.transaction(async (tx) => {
        const { reservedBytes, ...row } = input;
        await reserveStorage(
          context,
          tx,
          {
            id: row.reservationId,
            purpose: "screenshot",
            operationId: null,
            workspaceId: row.workspaceId,
            principalId: row.principalId,
            reservedBytes,
            reservedFiles: 1,
            expiresAt: row.expiresAt,
          },
          capacity,
          check,
        );
        await authorize(tx, row);
        check();
        const [inserted] = await tx
          .insert(outputs)
          .values({
            ...row,
            grantDigest: row.grantDigest ? Buffer.from(row.grantDigest) : null,
            state: "capturing",
            createdAt: new Date(),
          })
          .returning(columns);
        check();
        return requiredRow(inserted);
      });
    },
    async get(id: string) {
      const [row] = await db.select(columns).from(outputs).where(eq(outputs.id, id));
      return row ?? null;
    },
    publish(id: string, bytes: Uint8Array, check: () => void) {
      if (!bytes.length || bytes.length > SCREENSHOT_MAX_BYTES)
        throw new ApiError("relay.body_too_large", "Screenshot exceeds 4 MiB.");
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [found] = await tx.select(columns).from(outputs).where(eq(outputs.id, id)).for("update");
        const row = requiredRow(found);
        if (row.state !== "capturing") throw new ApiError("operation.conflict", "Screenshot capture has ended.");
        await authorize(tx, row);
        check();
        const [reservation] = await tx
          .select()
          .from(tables.storageReservations)
          .where(eq(tables.storageReservations.id, row.reservationId));
        if (reservation?.state !== "reserved" || bytes.length > reservation.reservedBytes)
          throw new ApiError("storage.capacity_exhausted", "Screenshot exceeds its reservation.");
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const [ready] = await tx
          .update(outputs)
          .set({ state: "ready", data: Buffer.from(bytes), bytes: bytes.length, digest, grantDigest: null })
          .where(eq(outputs.id, id))
          .returning(columns);
        // Keep the full reservation charged for database pages and bounded upload staging.
        await tx
          .update(tables.storageReservations)
          .set({
            state: "committed",
            materializedBytes: reservation.reservedBytes,
            materializedFiles: 1,
            updatedAt: new Date(),
          })
          .where(eq(tables.storageReservations.id, row.reservationId));
        await appendOutputTransaction(context, tx, {
          workspaceId: row.workspaceId,
          seq: 0,
          name: `screenshot-${id}`,
          value: screenshotResource(requiredRow(ready)),
          occurredAt: new Date(),
        });
        check();
        await authorize(tx, row);
        return requiredRow(ready);
      });
    },
    async content(id: string, principalId: string) {
      const [row] = await db
        .select({ data: outputs.data })
        .from(outputs)
        .innerJoin(tables.workspaces, eq(outputs.workspaceId, tables.workspaces.id))
        .where(
          and(
            eq(outputs.id, id),
            eq(outputs.principalId, principalId),
            eq(outputs.state, "ready"),
            isNull(tables.workspaces.purgeRequestedAt),
            gt(outputs.retainedUntil, new Date()),
          ),
        );
      return row?.data ?? null;
    },
    discard(id: string) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [row] = await tx
          .select({ id: outputs.id })
          .from(outputs)
          .where(and(eq(outputs.id, id), eq(outputs.state, "capturing")));
        if (row) await deleteBinaryOutputs(context, tx, [row.id], new Date());
      });
    },
    async prune(at: Date) {
      while (true) {
        const count = await db.transaction(async (tx) => {
          await lockStorageCapacity(context, tx);
          const rows = await tx
            .select({ id: outputs.id })
            .from(outputs)
            .where(
              or(
                and(eq(outputs.state, "capturing"), lte(outputs.expiresAt, at)),
                and(eq(outputs.state, "ready"), lte(outputs.retainedUntil, at)),
              ),
            )
            .limit(100);
          await deleteBinaryOutputs(
            context,
            tx,
            rows.map((row) => row.id),
            at,
          );
          return rows.length;
        });
        if (count < 100) break;
      }
    },
    purge(workspaceId: string) {
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        await requirePurgeFence(tx, tables, workspaceId);
        await purgeBinaryOutputs(context, tx, workspaceId, new Date());
      });
    },
  };
}

async function requirePurgeFence(tx: Transaction, tables: DatabaseContext["tables"], id: string) {
  const [row] = await tx
    .select({ purgeRequestedAt: tables.workspaces.purgeRequestedAt })
    .from(tables.workspaces)
    .where(eq(tables.workspaces.id, id))
    .for("update");
  if (!row?.purgeRequestedAt) throw new ApiError("operation.conflict", "Screenshot purge has not been admitted.");
}
