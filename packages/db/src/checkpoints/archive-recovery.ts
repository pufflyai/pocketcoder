import { closeSync, constants, fstatSync, fsyncSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointStageIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { openDataDirectory } from "../database/directory-identity";
import { destinationOpen, destinationStat, destinationUnlink } from "./destination-native";

export function removeInterruptedCheckpointPublication(
  directory: string,
  name: string,
  expected: CheckpointStageIdentity | null,
) {
  if (!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.tar$/.test(name)) throw new Error("Invalid checkpoint recovery name.");
  const folder = openDataDirectory(directory);
  function absent(member: string) {
    folder.validate();
    try {
      lstatSync(join(directory, member));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        folder.validate();
        return true;
      }
      throw error;
    }
    return false;
  }
  const names = [`.${name}.partial`, name];
  let removed = false;
  try {
    for (const member of names) {
      if (absent(member)) continue;
      if (!expected) throw new Error("Checkpoint recovery has no recorded file identity; storage remains charged.");
      const file = destinationOpen(folder.descriptor, member, constants.O_RDONLY);
      try {
        const held = fstatSync(file, { bigint: true });
        const named = destinationStat(folder.descriptor, member);
        // Writes and rename change content metadata. The recorded inode still owns this unfinished file.
        if (
          !held.isFile() ||
          held.nlink !== 1n ||
          named.dev !== held.dev ||
          named.ino !== held.ino ||
          String(held.dev) !== expected.device ||
          String(held.ino) !== expected.inode ||
          Number(held.uid) !== expected.uid ||
          Number(held.gid) !== expected.gid ||
          Number(held.mode & 0o777n) !== expected.mode ||
          expected.mode !== 0o600
        )
          throw new Error("Checkpoint recovery file identity changed; storage remains charged.");
        folder.validate();
        destinationUnlink(folder.descriptor, member, false);
        fsyncSync(folder.descriptor);
        if (fstatSync(file, { bigint: true }).nlink !== 0n)
          throw new Error("Checkpoint recovery inode still has a name; storage remains charged.");
        removed = true;
      } finally {
        closeSync(file);
      }
    }
    if (expected && !removed)
      throw new Error("Recorded checkpoint inode is absent without removal proof; storage remains charged.");
    return () => {
      const current = openDataDirectory(directory);
      try {
        for (const member of names) {
          current.validate();
          try {
            lstatSync(join(directory, member));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          throw new Error("Checkpoint recovery files remain; storage stays charged.");
        }
        current.validate();
      } finally {
        current.close();
      }
    };
  } finally {
    folder.close();
  }
}
