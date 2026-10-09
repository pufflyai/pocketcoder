import type { CheckpointPublication } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, ne } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockStorageCapacity } from "./reservation-capacity";
import { transferDeadline } from "./transfer-authority";
import { validateCheckpointTransfer } from "./transfer-validation";

export function createCheckpointTransferStaging(context: DatabaseContext) {
  const {
    db,
    tables: { checkpointTransfers: transfers },
  } = context;
  function transaction<T>(action: (tx: Transaction) => Promise<T>) {
    return db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      return action(tx);
    });
  }
  return {
    async listUnsettled() {
      context.validateStorage?.();
      return db.select().from(transfers).where(ne(transfers.state, "aborted"));
    },
    stage(id: string, receipt: Pick<CheckpointPublication, "stagePath" | "stageIdentity">, check: () => void) {
      return transaction(async (tx) => {
        const row = await validateCheckpointTransfer(context, tx, id, check);
        if (
          row.direction !== "upload" ||
          row.state !== "streaming" ||
          row.stageIdentity ||
          receipt.stagePath !== `${row.checkpointId}-${row.id}.tar`
        )
          throw new Error("Checkpoint publication staging is invalid.");
        const [updated] = await tx
          .update(transfers)
          .set({ ...receipt, state: "publishing", updatedAt: new Date() })
          .where(eq(transfers.id, id))
          .returning();
        transferDeadline(row.expiresAt, check);
        return requiredRow(updated);
      });
    },
  };
}
