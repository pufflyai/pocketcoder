import { and, eq, sql } from "drizzle-orm";
import type { DatabaseContext } from "../database/context";
import { createJournalAcknowledgement } from "../journal/acknowledgement";
import { createRecordReplay } from "./replay-records";
import { sourceWriterIdentity } from "./source-writer";
import { RecoveryStateSchema } from "./state";

// Database steps of a controller restore. The server runs purges and runtime fencing between them.
export function createRecovery(context: DatabaseContext) {
  const { db, journal, dataWriter, tables } = context;
  const { controllerState } = tables;
  const controller = eq(controllerState.id, "controller");
  const remoteJournal = createJournalAcknowledgement(context);

  async function state() {
    const [row] = await db.select({ recovery: controllerState.recovery }).from(controllerState).where(controller);
    return row?.recovery ? RecoveryStateSchema.parse(row.recovery) : null;
  }

  return {
    recoveryState: state,

    // Every journal event, in order. Throws when the journal cannot vouch for the backup position.
    async recoveryEvents() {
      const recovery = await state();
      if (!recovery) throw new Error("This controller is not in recovery.");
      if (!journal) throw new Error("Recovery requires the deletion journal.");
      const covered = journal.at(recovery.journal.sequence);
      if (journal.id !== recovery.journal.journalId || covered?.digest !== recovery.journal.digest)
        throw new Error("The deletion journal does not reach this backup's position. Recovery stays closed.");
      return journal.records().map((record) => record.event);
    },

    // Reapplies a journaled revocation, retirement or deletion of database content.
    applyRecord: createRecordReplay(context),

    // Moves the journal's writer claim to this folder, which fences the old one, then opens service.
    async finishRecovery(recoveryId: string) {
      if (!journal || !dataWriter) throw new Error("Recovery requires the deletion journal.");
      const claimed = journal.lastWriter();
      if (!claimed || sourceWriterIdentity(claimed) !== sourceWriterIdentity(dataWriter))
        journal.append({ kind: "writer_claimed", writer: dataWriter, at: new Date().toISOString() });
      await remoteJournal.acknowledge();
      await db
        .update(controllerState)
        .set({ recovery: null })
        .where(and(controller, sql`${controllerState.recovery}->>'recoveryId' = ${recoveryId}`));
    },
  };
}
