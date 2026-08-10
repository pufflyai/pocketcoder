import { controlPlaneClient } from "../../cli-context";

export async function printStorageInventory(showSummary: boolean, emptyMessage: boolean) {
  const body = await controlPlaneClient().administration.storageInventory();
  if (showSummary) {
    console.log(
      `storage: ${body.backend}; allocations=${body.storage_count}; checkpoints=${body.checkpoint_count}`,
    );
  }
  for (const id of body.unknown_storage) console.log(`storage\t${id}`);
  for (const id of body.unknown_checkpoints) console.log(`checkpoint\t${id}`);
  if (emptyMessage && body.unknown_storage.length === 0 && body.unknown_checkpoints.length === 0) {
    console.log("(no orphaned physical objects)");
  }
}
