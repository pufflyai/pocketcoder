import { loadOffNodeConfig, type OffNodeRestoreInput, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

type Input =
  | { kind: "backup"; path: string; source: string; id: string }
  | { kind: "restore"; path: string; input: Omit<OffNodeRestoreInput, "offNode"> };

const input: Input = JSON.parse(process.argv[2] as string);
const offNode = await loadOffNodeConfig(input.path);
if (input.kind === "restore") {
  console.log(JSON.stringify(await restoreOffNodeBackup({ ...input.input, offNode })));
} else {
  const controller = await openControllerStore(input.source, undefined, {
    acknowledgeJournal: offNode.journal.acknowledge,
  });
  try {
    const backup = createControllerBackup({
      store: controller.store,
      keys: controller.keys,
      maintenance: createMaintenance(),
    });
    const run = createOffNodeBackup({ store: controller.store, offNode, backup });
    console.log(JSON.stringify(await run(input.id, new AbortController().signal)));
  } finally {
    await controller.store.close();
  }
}
