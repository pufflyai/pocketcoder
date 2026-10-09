import { constants, fstatSync, fsyncSync } from "node:fs";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { closeDestinationDescriptor } from "./destination-close";
import {
  assertDestinationCustody,
  assertDestinationIdentity,
  type createDestinationCustody,
  destinationCustody,
} from "./destination-custody";
import type { createDestinationDirectories } from "./destination-directory";
import { destinationLinkTime } from "./destination-metadata";
import { destinationChmod, destinationOpen, destinationStat } from "./destination-native";

export async function finalizeDestinationDirectory(
  requested: CheckpointArchiveEntry,
  ledger: Awaited<ReturnType<typeof createDestinationCustody>>,
  directories: ReturnType<typeof createDestinationDirectories>,
  sync: (descriptor: number) => void = fsyncSync,
) {
  if (requested.kind !== "directory") throw new Error("Checkpoint destination entry is not a directory.");
  const ordinal = await ledger.locate(requested);
  const entry = await ledger.entryAt(ordinal);
  const slot = ledger.read(ordinal);
  if (!slot[0]) throw new Error("Checkpoint destination directory is missing.");
  const parent = await directories.openParent(entry);
  try {
    assertDestinationCustody(destinationStat(parent.descriptor, parent.name), slot.subarray(8, 72));
    destinationChmod(parent.descriptor, parent.name, 0o700);
    const descriptor = destinationOpen(parent.descriptor, parent.name, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      assertDestinationIdentity(fstatSync(descriptor, { bigint: true }), slot.subarray(8, 72));
      destinationChmod(parent.descriptor, parent.name, entry.mode);
      destinationLinkTime(parent.descriptor, parent.name, entry.mtime_ns);
      const stat = destinationStat(parent.descriptor, parent.name);
      assertDestinationIdentity(stat, slot.subarray(8, 72));
      if ((stat.mode & 0o777n) !== BigInt(entry.mode) || stat.mtimeNs !== BigInt(entry.mtime_ns))
        throw new Error("Checkpoint directory metadata differs.");
      // Flush the final metadata while the original child remains held, even at mode 000.
      sync(descriptor);
      const expected = destinationCustody(stat);
      assertDestinationCustody(fstatSync(descriptor, { bigint: true }), expected);
      assertDestinationCustody(destinationStat(parent.descriptor, parent.name), expected);
      ledger.retain(ordinal, stat, slot.readUInt8(0));
      parent.validateNative();
    } finally {
      closeDestinationDescriptor(descriptor, slot.subarray(8, 72));
    }
  } finally {
    parent.close();
  }
}
