import type {
  PhysicalStorageAmount,
  ReadStorageCapacity,
  StorageReservationInput,
} from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import {
  admitStorageOwner,
  lockStorageCapacity,
  reserveStorage,
  storageAmount,
  storageUsage,
} from "./reservation-capacity";

export function createStorageReservations(context: DatabaseContext) {
  const {
    db,
    tables: { storageReservations: reservations },
  } = context;
  async function update(
    id: string,
    check: () => void,
    change: (
      row: typeof reservations.$inferSelect,
      tx: Transaction,
    ) => Partial<typeof reservations.$inferInsert> | Promise<Partial<typeof reservations.$inferInsert>>,
  ) {
    return db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      check();
      const [row] = await tx.select().from(reservations).where(eq(reservations.id, id)).for("update");
      const current = requiredRow(row);
      const patch = await change(current, tx);
      check();
      const [updated] = await tx
        .update(reservations)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(reservations.id, id))
        .returning();
      check();
      if (patch.state === "committed" && current.expiresAt <= new Date())
        throw new Error("Storage reservation deadline expired before commit.");
      return requiredRow(updated);
    });
  }
  return {
    reserve(input: StorageReservationInput, readCapacity: ReadStorageCapacity, check: () => void) {
      const reservation = { ...input, expiresAt: new Date(input.expiresAt) };
      return db.transaction((tx) => reserveStorage(context, tx, reservation, readCapacity, check));
    },
    async get(id: string) {
      const [row] = await db.select().from(reservations).where(eq(reservations.id, id));
      return row ?? null;
    },
    usage(workspaceId: string | null, principalId: string | null) {
      return storageUsage(context, db, workspaceId, principalId);
    },
    materialize(id: string, amount: PhysicalStorageAmount, check: () => void) {
      storageAmount(amount);
      return update(id, check, (row) => {
        if (
          !["reserved", "releasing"].includes(row.state) ||
          amount.bytes > row.reservedBytes ||
          amount.files > row.reservedFiles
        )
          throw new Error("Materialized storage exceeds its active reservation.");
        return { materializedBytes: amount.bytes, materializedFiles: amount.files };
      });
    },
    commit(id: string, check: () => void) {
      return update(id, check, async (row, tx) => {
        if (row.state !== "reserved") throw new Error("Storage reservation cannot commit in this state.");
        await admitStorageOwner(context, tx, row, check);
        return { state: "committed", reservedBytes: row.materializedBytes, reservedFiles: row.materializedFiles };
      });
    },
    beginRelease(id: string, check: () => void) {
      return update(id, check, (row) => {
        if (row.state === "released") throw new Error("Storage reservation is already released.");
        return { state: "releasing" };
      });
    },
    release(id: string, checkRemoved: () => void) {
      return update(id, checkRemoved, (row) => {
        if (row.state !== "releasing") throw new Error("Storage reservation must drain before release.");
        return {
          state: "released",
          reservedBytes: 0,
          reservedFiles: 0,
          materializedBytes: 0,
          materializedFiles: 0,
          releasedAt: new Date(),
        };
      });
    },
  };
}
