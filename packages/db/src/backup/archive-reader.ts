import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileChunks } from "./file-chunks";
import {
  type BackupManifest,
  BackupManifestSchema,
  type BackupMember,
  isBackupMemberPath,
  MANIFEST_PATH,
} from "./manifest";
import { BLOCK, parseTarHeader, type TarMember, tarPadding } from "./tar";

const MAX_MANIFEST_BYTES = 16 * 1024 ** 2;

function readExact(file: number, bytes: number, position: number) {
  const buffer = Buffer.alloc(bytes);
  if (readSync(file, buffer, 0, bytes, position) !== bytes) throw new Error("Backup archive is truncated.");
  return buffer;
}

function readManifest(file: number, member: TarMember, offset: number) {
  if (member.size > MAX_MANIFEST_BYTES) throw new Error("Backup manifest is too large.");
  return BackupManifestSchema.parse(JSON.parse(readExact(file, member.size, offset).toString("utf8")));
}

function assertPlacement(member: TarMember, members: BackupMember[], directories: Set<string>) {
  if (!isBackupMemberPath(member.path)) throw new Error(`Backup archive has an unexpected member: ${member.path}`);
  if (members.some((existing) => existing.path === member.path))
    throw new Error(`Backup archive repeats ${member.path}.`);
  const parent = dirname(member.path);
  if (parent !== "." && !directories.has(parent)) throw new Error(`Backup member precedes its folder: ${member.path}`);
}

// Hashes a file member; database members are also extracted so the snapshot can be opened.
async function readFileMember(file: number, member: TarMember, offset: number, scratch: string) {
  const extract = member.path.startsWith("db/")
    ? openSync(join(scratch, member.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    : undefined;
  const hash = createHash("sha256");
  try {
    for await (const chunk of fileChunks(file, member.size, () => {}, offset)) {
      hash.update(chunk);
      if (extract !== undefined) writeSync(extract, chunk);
    }
  } finally {
    if (extract !== undefined) closeSync(extract);
  }
  return { path: member.path, type: "file" as const, bytes: member.size, digest: `sha256:${hash.digest("hex")}` };
}

export async function scanArchive(file: number, size: number, scratch: string) {
  const members: BackupMember[] = [];
  const directories = new Set<string>();
  let manifest: BackupManifest | undefined;
  let offset = 0;
  for (
    let member = parseTarHeader(readExact(file, BLOCK, 0));
    member;
    member = parseTarHeader(readExact(file, BLOCK, offset))
  ) {
    offset += BLOCK;
    if (manifest) throw new Error("Backup archive has members after its manifest.");
    if (offset + member.size > size) throw new Error("Backup archive is truncated.");
    if (member.path === MANIFEST_PATH) manifest = readManifest(file, member, offset);
    else {
      assertPlacement(member, members, directories);
      if (member.type === "directory") {
        directories.add(member.path);
        if (member.path.startsWith("db")) mkdirSync(join(scratch, member.path), { mode: 0o700 });
        members.push({ path: member.path, type: "directory" });
      } else members.push(await readFileMember(file, member, offset, scratch));
    }
    offset += member.size + tarPadding(member.size);
  }
  // The end marker is two zero blocks with nothing after them.
  if (parseTarHeader(readExact(file, BLOCK, offset + BLOCK)) || offset + BLOCK * 2 !== size)
    throw new Error("Backup archive has data after its end.");
  if (!manifest) throw new Error("Backup archive has no manifest.");
  return { manifest, members };
}
