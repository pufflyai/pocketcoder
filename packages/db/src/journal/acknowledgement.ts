import { ApiError, type SourceWriter } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext } from "../database/context";
import type { JournalCursor, JournalRecord } from "./events";

export interface JournalSnapshot {
  head: JournalCursor;
  records: JournalRecord[];
  writer: SourceWriter;
}

export type JournalAcknowledgement = (snapshot: JournalSnapshot) => Promise<void>;

export function createJournalAcknowledgement(context: DatabaseContext) {
  const { journal, dataWriter, acknowledgeJournal } = context;
  let pending = Promise.resolve();
  const acknowledge = () => {
    const attempt = pending.then(async () => {
      if (!acknowledgeJournal) return;
      if (!journal || !dataWriter) throw new Error("Remote journal requires a durable data folder.");
      // A response may reflect another transaction that committed while the upload was in flight.
      let covered: JournalCursor;
      do {
        covered = journal.head();
        await acknowledgeJournal({ head: covered, records: journal.records(), writer: dataWriter });
      } while (journal.head().digest !== covered.digest);
    });
    pending = attempt.catch(() => {});
    return attempt.catch(() => {
      throw new ApiError("journal.pending", "The change is enforced but its remote journal is pending.", {
        retryable: true,
      });
    });
  };
  return {
    acknowledge,
    after<Args extends unknown[], Result>(mutation: (...args: Args) => Promise<Result>) {
      return async (...args: Args) => {
        const result = await mutation(...args);
        // The repository has finished its transaction before any network request starts.
        await acknowledge();
        return result;
      };
    },
  };
}
