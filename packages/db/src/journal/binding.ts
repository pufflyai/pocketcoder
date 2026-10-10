import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { sourceWriterIdentity } from "../recovery/source-writer";
import type { createSchema } from "../schema";
import { openJournal } from "./journal";

// Binds the data folder to its deletion journal. Outside recovery, only the data folder
// that last claimed the journal may write; a restore moves that claim to the new folder.
export async function bindJournal(
  db: PgliteDatabase,
  tables: ReturnType<typeof createSchema>,
  dataDirectory: string,
  writer: SourceWriter,
  override?: string,
) {
  const where = eq(tables.controllerState.id, "controller");
  const [state] = await db.select().from(tables.controllerState).where(where);
  const bound = state?.journal ?? null;
  const journal = openJournal(override ?? bound?.directory ?? `${dataDirectory}-journal`, dataDirectory, !bound);
  try {
    if (bound && bound.journalId !== journal.id)
      throw new Error(`This data folder belongs to deletion journal ${bound.journalId}, not ${journal.directory}.`);
    if (bound?.directory !== journal.directory)
      await db
        .update(tables.controllerState)
        .set({ journal: { journalId: journal.id, directory: journal.directory } })
        .where(where);
    if (state?.recovery === null) {
      const claimed = journal.lastWriter();
      if (!claimed) journal.append({ kind: "writer_claimed", writer, at: new Date().toISOString() });
      else if (sourceWriterIdentity(claimed) !== sourceWriterIdentity(writer))
        throw new Error(`This data folder was replaced by a restore. Start ${claimed.directory} instead.`);
    }
    return journal;
  } catch (error) {
    journal.close();
    throw error;
  }
}
