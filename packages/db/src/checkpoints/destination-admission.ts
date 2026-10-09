import { relative, resolve } from "node:path";
import type { createDestinationCustody } from "./destination-custody";
import type { DestinationMount } from "./destination-directory";

export function admitDestinationMounts(mounts: readonly DestinationMount[], directory: string) {
  if (mounts.length > 16 || new Set(mounts.map(({ policy }) => policy.name)).size !== mounts.length)
    throw new Error("Checkpoint destination mounts are invalid.");
  const scratch = resolve(directory);
  for (const mount of mounts) {
    const child = relative(resolve(mount.parent), scratch);
    if (child !== ".." && !child.startsWith("../"))
      throw new Error("Checkpoint scratch must be outside destination parents.");
  }
  return scratch;
}
export async function admitDestinationCounts(
  mounts: readonly DestinationMount[],
  ledger: Awaited<ReturnType<typeof createDestinationCustody>>,
) {
  const counts = mounts.map(() => ({ bytes: 0, files: 0 }));
  for await (const entry of ledger.entries()) {
    const count = counts[entry.mount];
    const policy = mounts[entry.mount]?.policy;
    if (!count || !policy) throw new Error("Checkpoint destination mount is not admitted.");
    count.bytes += entry.size;
    count.files++;
    if (!Number.isSafeInteger(count.bytes) || count.bytes > policy.maxBytes || count.files > policy.maxFiles)
      throw new Error("Checkpoint destination exceeds its mount reservation.");
  }
}
