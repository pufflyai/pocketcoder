import type { PGliteStore } from "@pstdio/pocketcoder-db";
import type { OffNode } from "@pstdio/pocketcoder-db/off-node";
import type { Maintenance } from "../maintenance/maintenance";
import { createOffNodeRecovery } from "../recovery/off-node-recovery";
import { type ControllerKeys, createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

export function composeBackups(
  input: { store: PGliteStore; keyBundle?: ControllerKeys; offNode?: OffNode; directory: string },
  maintenance: Maintenance,
  checkpointDirectory?: string,
) {
  const backup = createControllerBackup({
    store: input.store,
    maintenance,
    keys: input.keyBundle,
    checkpointDirectory,
  });
  return {
    backup,
    ...(input.offNode
      ? {
          offNodeBackup: createOffNodeBackup({ store: input.store, backup, offNode: input.offNode }),
          offNodeRecovery: createOffNodeRecovery(input.store, input.offNode, input.directory),
        }
      : {}),
  };
}
