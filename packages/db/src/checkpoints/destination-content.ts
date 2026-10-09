import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, read } from "node:fs";
import { promisify } from "node:util";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import type { createDestinationCustody } from "./destination-custody";
import { assertDestinationCustody, assertDestinationIdentity, destinationCustody } from "./destination-custody";
import type { createDestinationDirectories } from "./destination-directory";
import { destinationChmod, destinationOpen, destinationStat } from "./destination-native";
import type { DestinationStat } from "./destination-stat";

const readBytes = promisify(read);
type Ledger = Awaited<ReturnType<typeof createDestinationCustody>>;
type Folders = ReturnType<typeof createDestinationDirectories>;

export function assertDestinationRename(stat: DestinationStat, expected: Buffer) {
  const actual = destinationCustody(stat);
  if (!actual.subarray(0, 32).equals(expected.subarray(0, 32)) || !actual.subarray(40).equals(expected.subarray(40)))
    throw new Error("Checkpoint entry changed during publication rename.");
}

export async function verifyDestinationContent(entry: CheckpointArchiveEntry, ledger: Ledger, folders: Folders) {
  if (entry.kind !== "file") return;
  const ordinal = await ledger.locate(entry);
  const state = ledger.read(ordinal)[0] ?? 0;
  const parent = await folders.openParent(entry);
  let file: number | undefined;
  let expected = ledger.read(ordinal).subarray(8, 72);
  try {
    parent.validateNative();
    assertDestinationCustody(destinationStat(parent.descriptor, parent.name), expected);
    destinationChmod(parent.descriptor, parent.name, entry.mode | 0o400);
    file = destinationOpen(parent.descriptor, parent.name, constants.O_RDONLY);
    const stat = fstatSync(file, { bigint: true });
    assertDestinationIdentity(stat, expected);
    if (
      stat.size !== BigInt(entry.size) ||
      stat.mtimeNs !== BigInt(entry.mtime_ns) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== BigInt(entry.mode | 0o400)
    )
      throw new Error("Published checkpoint file metadata differs.");
    expected = destinationCustody(stat);
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(65_536);
    let offset = 0;
    while (offset < entry.size) {
      assertDestinationCustody(fstatSync(file, { bigint: true }), expected);
      const result = await readBytes(file, bytes, 0, Math.min(bytes.length, entry.size - offset), offset);
      parent.validateNative();
      assertDestinationCustody(fstatSync(file, { bigint: true }), expected);
      assertDestinationCustody(destinationStat(parent.descriptor, parent.name), expected);
      if (!result.bytesRead) throw new Error("Published checkpoint file was truncated.");
      hash.update(bytes.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (`sha256:${hash.digest("hex")}` !== entry.digest) throw new Error("Published checkpoint file digest differs.");
    assertDestinationCustody(fstatSync(file, { bigint: true }), expected);
    fchmodSync(file, entry.mode);
    const sealed = fstatSync(file, { bigint: true });
    assertDestinationIdentity(sealed, expected);
    if (
      sealed.size !== BigInt(entry.size) ||
      sealed.mtimeNs !== BigInt(entry.mtime_ns) ||
      sealed.nlink !== 1n ||
      (sealed.mode & 0o777n) !== BigInt(entry.mode)
    )
      throw new Error("Published checkpoint file metadata differs.");
    fsyncSync(file);
    assertDestinationCustody(destinationStat(parent.descriptor, parent.name), destinationCustody(sealed));
    ledger.retain(ordinal, sealed, state);
  } finally {
    if (file !== undefined) closeSync(file);
    parent.close();
  }
}
