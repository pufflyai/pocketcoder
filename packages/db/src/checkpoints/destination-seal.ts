import { verifyDestinationContent } from "./destination-content";
import type { createDestinationCustody } from "./destination-custody";
import type { createDestinationDirectories } from "./destination-directory";
import { finalizeDestinationDirectory } from "./destination-finalize";
import type { createDestinationInventory } from "./destination-inventory";

export async function sealDestinationGraph(
  custody: Awaited<ReturnType<typeof createDestinationCustody>>,
  folders: ReturnType<typeof createDestinationDirectories>,
  inventory: ReturnType<typeof createDestinationInventory>,
  verifyContent = false,
) {
  await inventory.restoreSearch();
  await inventory.census(true);
  if (verifyContent) {
    for await (const entry of custody.entries()) await verifyDestinationContent(entry, custody, folders);
    await inventory.census(true);
  }
  for await (const entry of custody.entries({ reverse: true }))
    if (entry.kind === "directory") await finalizeDestinationDirectory(entry, custody, folders);
  folders.sync();
  folders.validateNative();
}
