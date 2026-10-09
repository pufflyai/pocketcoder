import { type CheckpointArchiveEntry, validateCheckpointEntryGraph } from "@pstdio/pocketcoder-contracts";
import type { createCheckpointEntryIndex } from "./entry-index";

type Index = ReturnType<ReturnType<typeof createCheckpointEntryIndex>["seal"]>;

export async function validateCheckpointIndexGraph(index: Index, check: () => void) {
  // One ancestor path bounds memory. Reuse ordinals, never cached file facts.
  let previousMount = -1;
  let previousParts: string[] = [];
  let previousOrdinals: number[] = [];
  for await (const entry of index.entries()) {
    check();
    const ordinals: number[] = [];
    const parts = entry.path.split("/");
    parts.pop();
    let parentPosition = 0;
    let shared = previousMount === entry.mount;
    async function lookup(mount: number, path: string): Promise<CheckpointArchiveEntry | null> {
      const position = parentPosition++;
      if (mount !== entry.mount || position >= parts.length) return index.lookup(mount, path);
      shared = shared && previousParts[position] === parts[position];
      const cached = shared ? previousOrdinals[position] : undefined;
      const ordinal = cached ?? (await index.ordinal(mount, path));
      if (ordinal === null) return null;
      // Fresh sealed-index reads retain the same native custody and acceptance proof.
      const record = await index.entryAt(ordinal);
      if (record.mount !== mount || record.path !== path) throw new Error("Checkpoint graph parent binding changed.");
      ordinals[position] = ordinal;
      return record;
    }
    await validateCheckpointEntryGraph(entry, lookup);
    check();
    previousMount = entry.mount;
    previousParts = parts;
    previousOrdinals = ordinals;
  }
}
