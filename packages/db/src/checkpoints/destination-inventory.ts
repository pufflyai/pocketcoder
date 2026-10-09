import { closeSync, constants, fstatSync, fsyncSync } from "node:fs";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { assertDestinationCustody, type createDestinationCustody } from "./destination-custody";
import { type createDestinationDirectories, destinationNames } from "./destination-directory";
import { destinationOpen, destinationReadlink, destinationStat, destinationUnlink } from "./destination-native";

type Ledger = Awaited<ReturnType<typeof createDestinationCustody>>;
type Directories = ReturnType<typeof createDestinationDirectories>;
export function createDestinationInventory(ledger: Ledger, directories: Directories) {
  async function restoreSearch() {
    let ordinal = 0;
    for await (const entry of ledger.entries()) {
      if (entry.kind === "directory") await directories.restoreSearch(entry, ordinal);
      ordinal++;
    }
  }
  async function inspectDirectory(mount: number, path: string, descriptor: number) {
    const names = destinationNames(descriptor);
    try {
      let name = names.next();
      while (name !== undefined) {
        const member = path ? `${path}/${name}` : name;
        const ordinal = await ledger.ordinal(mount, member);
        if (ordinal === null || !ledger.read(ordinal)[0]) throw new Error("Unknown checkpoint destination content.");
        assertDestinationCustody(destinationStat(descriptor, name), ledger.read(ordinal).subarray(8, 72));
        name = names.next();
      }
    } finally {
      names.close();
    }
  }
  async function inspectEntry(entry: CheckpointArchiveEntry, ordinal: number, requireComplete: boolean) {
    const slot = ledger.read(ordinal);
    if (!slot[0]) {
      if (requireComplete) throw new Error("Checkpoint destination entry is missing.");
      return;
    }
    if (requireComplete && slot[0] !== 2 && slot[0] !== 3)
      throw new Error("Checkpoint destination entry is incomplete.");
    const parent = await directories.openParent(entry);
    try {
      const stat = destinationStat(parent.descriptor, parent.name);
      assertDestinationCustody(stat, slot.subarray(8, 72));
      if (entry.kind === "directory") {
        const descriptor = destinationOpen(parent.descriptor, parent.name, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await inspectDirectory(entry.mount, entry.path, descriptor);
        } finally {
          closeSync(descriptor);
        }
      } else if (entry.kind === "symlink" && destinationReadlink(parent.descriptor, parent.name) !== entry.link_target)
        throw new Error("Checkpoint destination link differs.");
      parent.validateNative();
    } finally {
      parent.close();
    }
  }
  async function census(requireComplete: boolean) {
    directories.validateNative();
    for (const [mount, stage] of directories.stages.entries()) await inspectDirectory(mount, "", stage.descriptor);
    // Iteration reads the sealed index in ordinal order. Do not search the same
    // immutable record again; every native entry and ancestor is still checked.
    let ordinal = 0;
    for await (const entry of ledger.entries()) await inspectEntry(entry, ordinal++, requireComplete);
    // A later visit must not allow edits to an already visited directory or file.
    ordinal = 0;
    for await (const entry of ledger.entries()) {
      const slot = ledger.read(ordinal++);
      if (!slot[0]) continue;
      const parent = await directories.openParent(entry);
      try {
        assertDestinationCustody(destinationStat(parent.descriptor, parent.name), slot.subarray(8, 72));
        parent.validateNative();
      } finally {
        parent.close();
      }
    }
    directories.validateNative();
  }
  async function remove() {
    await restoreSearch();
    await census(false);
    let ordinal = ledger.count;
    for await (const entry of ledger.entries({ reverse: true })) {
      ordinal--;
      const slot = ledger.read(ordinal);
      if (!slot[0]) continue;
      const parent = await directories.openParent(entry);
      try {
        assertDestinationCustody(destinationStat(parent.descriptor, parent.name), slot.subarray(8, 72));
        destinationUnlink(parent.descriptor, parent.name, entry.kind === "directory");
        parent.refresh();
        // A removed slot cannot authorize later deletion of a reused name.
        ledger.retain(ordinal, fstatSync(parent.descriptor, { bigint: true }), 0);
        fsyncSync(parent.descriptor);
        parent.validateNative();
      } finally {
        parent.close();
      }
    }
    directories.removeStages();
  }
  return { restoreSearch, census, remove };
}
