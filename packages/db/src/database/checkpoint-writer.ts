import { digestOf, type SourceWriter, SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "./context";
import type { lockDataFolder } from "./data-folder";

export async function bindCheckpointWriter(
  db: DatabaseContext["db"],
  tables: DatabaseContext["tables"],
  folder?: ReturnType<typeof lockDataFolder>,
) {
  if (!folder) return undefined;
  const dataWriter: SourceWriter = folder.sourceWriter();
  const check = folder.validate;
  check();
  await db
    .insert(tables.controllerState)
    .values({ id: "controller", sourceWriter: dataWriter, recovery: null })
    .onConflictDoNothing();
  const [state] = await db.select().from(tables.controllerState).where(eq(tables.controllerState.id, "controller"));
  if (!state?.sourceWriter || digestOf(SourceWriterSchema.parse(state.sourceWriter)) !== digestOf(dataWriter))
    throw new Error("Checkpoint writer identity differs from this data folder.");
  check();
  return dataWriter;
}
