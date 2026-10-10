import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import { jsonb, type PgTableFn, text } from "drizzle-orm/pg-core";

export function createTransferControllerTable(table: PgTableFn<string | undefined>) {
  return {
    controllerState: table("checkpoint_controller_state", {
      id: text("id").primaryKey(),
      sourceWriter: jsonb("source_writer").$type<SourceWriter>(),
      recovery: jsonb("recovery").$type<unknown>(),
      // The deletion journal this data folder reports to; it lives outside the data folder.
      journal: jsonb("journal").$type<{ journalId: string; directory: string }>(),
    }),
  };
}
