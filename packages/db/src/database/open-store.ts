import { convertLegacyConversations } from "../modules/conversations/legacy-conversion";
import { createRecordReplay } from "../recovery/replay-records";
import type { DatabaseOpenOptions } from "./context";
import { createPGliteContext } from "./pglite-context";
import { createPostgresContext, type PostgresOptions } from "./postgres-context";

export async function openPGliteStoreContext(dataDir?: string, options?: DatabaseOpenOptions) {
  const context = await createPGliteContext(dataDir, options);
  try {
    await convertLegacyConversations(context);
  } catch (error) {
    await context.close();
    throw error;
  }
  return context;
}
export async function openPostgresStoreContext(options: PostgresOptions) {
  const context = await createPostgresContext(options);
  try {
    await convertLegacyConversations(context, { onProgress: options.onConversionProgress });
    // A restore can roll back revocations. Replay exact journal targets on every start.
    const replay = createRecordReplay(context);
    for (const record of context.journal?.records() ?? []) await replay(record.event);
  } catch (error) {
    await context.close();
    throw error;
  }
  return context;
}
