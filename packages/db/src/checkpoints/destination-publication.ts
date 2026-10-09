import { closeSync, constants, fstatSync, fsyncSync } from "node:fs";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { assertDestinationRename } from "./destination-content";
import {
  assertDestinationCustody,
  assertDestinationIdentity,
  type createDestinationCustody,
  destinationCustody,
} from "./destination-custody";
import { type createDestinationDirectories, destinationNames } from "./destination-directory";
import {
  destinationChmod,
  destinationOpen,
  destinationRenameNoReplace,
  destinationStat,
  destinationUnlink,
} from "./destination-native";

type Folders = ReturnType<typeof createDestinationDirectories>;
type Ledger = Awaited<ReturnType<typeof createDestinationCustody>>;

function admitRoots(folders: Folders) {
  folders.validateNative();
  const roots = new Set<number>();
  for (const stage of folders.stages) {
    if (roots.has(stage.parent.descriptor)) throw new Error("Published mounts need separate disposable roots.");
    roots.add(stage.parent.descriptor);
    const names = destinationNames(stage.parent.descriptor);
    try {
      let name = names.next();
      while (name !== undefined) {
        if (name !== stage.name) throw new Error("Unknown content in checkpoint publication root.");
        name = names.next();
      }
    } finally {
      names.close();
    }
  }
}
function refresh(folders: Folders, mount: number) {
  const stage = folders.stages[mount];
  if (!stage) throw new Error("Checkpoint publication mount is not held.");
  stage.expected = destinationCustody(fstatSync(stage.descriptor, { bigint: true }));
  stage.parent.expected = destinationCustody(fstatSync(stage.parent.descriptor, { bigint: true }));
}

async function moveEntry(entry: CheckpointArchiveEntry, folders: Folders, ledger: Ledger) {
  const ordinal = await ledger.locate(entry);
  const stage = folders.stages[entry.mount];
  if (!stage) throw new Error("Checkpoint publication mount is not held.");
  folders.validateNative();
  let expected = ledger.read(ordinal).subarray(8, 72);
  assertDestinationCustody(destinationStat(stage.descriptor, entry.path), expected);
  let held: number | undefined;
  if (entry.kind === "directory") {
    destinationChmod(stage.descriptor, entry.path, 0o700);
    held = destinationOpen(stage.descriptor, entry.path, constants.O_RDONLY | constants.O_DIRECTORY);
    const searchable = destinationStat(stage.descriptor, entry.path);
    assertDestinationIdentity(searchable, expected);
    ledger.retain(ordinal, searchable, 2);
    expected = destinationCustody(searchable);
  }
  try {
    destinationRenameNoReplace(stage.descriptor, entry.path, stage.parent.descriptor, entry.path);
    const renamed = destinationStat(stage.parent.descriptor, entry.path);
    assertDestinationRename(renamed, expected);
    ledger.retain(ordinal, renamed, 3);
    refresh(folders, entry.mount);
    if (entry.kind === "directory") destinationChmod(stage.parent.descriptor, entry.path, entry.mode);
    ledger.retain(ordinal, destinationStat(stage.parent.descriptor, entry.path), 3);
    if (held !== undefined) fsyncSync(held);
  } finally {
    if (held !== undefined) closeSync(held);
  }

  const stat = destinationStat(stage.parent.descriptor, entry.path);
  assertDestinationIdentity(stat, expected);
  const admittedMode = entry.kind === "directory" ? entry.mode : expected.readUInt32BE(48) & 0o777;
  if (
    stat.size !== expected.readBigInt64BE(16) ||
    stat.mtimeNs !== expected.readBigInt64BE(24) ||
    (stat.mode & 0o777n) !== BigInt(admittedMode) ||
    stat.nlink !== expected.readBigInt64BE(40)
  )
    throw new Error("Checkpoint entry metadata changed during publication.");
  ledger.retain(ordinal, stat, 3);
  refresh(folders, entry.mount);
  fsyncSync(stage.parent.descriptor);
  fsyncSync(stage.descriptor);
}
async function rollbackMoves(folders: Folders, ledger: Ledger) {
  for await (const entry of ledger.entries({ reverse: true })) {
    if (entry.path.includes("/")) continue;
    const ordinal = await ledger.locate(entry);
    if (ledger.read(ordinal)[0] !== 3) continue;
    const stage = folders.stages[entry.mount];
    if (!stage) throw new Error("Checkpoint rollback mount is not held.");
    folders.validateNative();
    const expected = ledger.read(ordinal).subarray(8, 72);
    assertDestinationCustody(destinationStat(stage.parent.descriptor, entry.path), expected);
    const admitted = entry;
    if (admitted.kind === "directory") destinationChmod(stage.parent.descriptor, entry.path, 0o700);
    destinationRenameNoReplace(stage.parent.descriptor, entry.path, stage.descriptor, entry.path);
    if (admitted.kind === "directory") destinationChmod(stage.descriptor, entry.path, admitted.mode);
    const stat = destinationStat(stage.descriptor, entry.path);
    assertDestinationIdentity(stat, expected);
    ledger.retain(ordinal, stat, 2);
    refresh(folders, entry.mount);
    fsyncSync(stage.parent.descriptor);
    fsyncSync(stage.descriptor);
  }
}
async function assertPublishedRoots(folders: Folders, ledger: Ledger) {
  folders.validateNative();
  for (const [mount, stage] of folders.stages.entries()) {
    const names = destinationNames(stage.parent.descriptor);
    try {
      let name = names.next();
      while (name !== undefined) {
        if (name !== stage.name) {
          const ordinal = await ledger.ordinal(mount, name);
          folders.validateNative();
          if (ordinal === null || ledger.read(ordinal)[0] !== 3)
            throw new Error("Unknown content in published checkpoint root.");
          assertDestinationCustody(
            destinationStat(stage.parent.descriptor, name),
            ledger.read(ordinal).subarray(8, 72),
          );
        }
        name = names.next();
      }
    } finally {
      names.close();
    }
  }
}
function releaseStages(folders: Folders) {
  for (const stage of folders.stages) {
    folders.validateNative();
    destinationUnlink(stage.parent.descriptor, stage.name, true);
    stage.removed = true;
    stage.expected = destinationCustody(fstatSync(stage.descriptor, { bigint: true }));
    stage.parent.expected = destinationCustody(fstatSync(stage.parent.descriptor, { bigint: true }));
    fsyncSync(stage.parent.descriptor);
  }
}
export async function publishDestinationMounts(folders: Folders, ledger: Ledger, complete: () => Promise<void>) {
  admitRoots(folders);
  try {
    for await (const entry of ledger.entries()) if (!entry.path.includes("/")) await moveEntry(entry, folders, ledger);
    folders.usePublishedRoots(true);
    await complete();
  } catch (error) {
    folders.usePublishedRoots(false);
    await rollbackMoves(folders, ledger);
    throw error;
  }
  await assertPublishedRoots(folders, ledger);
  releaseStages(folders);
  return folders.stages.map((stage) => {
    const stat = fstatSync(stage.parent.descriptor, { bigint: true });
    return { path: stage.parent.path, dev: stat.dev.toString(), ino: stat.ino.toString() };
  });
}
