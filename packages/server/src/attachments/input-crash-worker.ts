import { PGliteStore } from "@pstdio/pocketcoder-db";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { inputBacking } from "./input-storage";

export async function crashInputPublication(directory: string, root: string, phase: string) {
  const store = await PGliteStore.create(directory);
  const row = (await store.inputs.list())[0]!;
  const storage = new FilesystemInputStorage(root, []);
  const writer = await storage.create(inputBacking(row));
  await writer.write(Buffer.from("original"));
  if (phase !== "writing") await writer.publish();
  if (phase === "committed")
    await store.inputs.publish(row.reference.workspaceId, row.reference.fileId, row.reservationId);
  process.kill(process.pid, "SIGKILL");
}
if (import.meta.main) await crashInputPublication(process.argv[2]!, process.argv[3]!, process.argv[4]!);
