import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BLOCK, createArchiveOutput, fileChunks, parseTarHeader, tarPadding } from "@pstdio/pocketcoder-db/backup";
import type { ManagerContext } from "../database/context";
import type { ManagerCursor } from "./journal";
import { currentFormat, ManagerManifestSchema, requireManagerFormat } from "./manifest";

const skipped = new Set(["postmaster.pid", "postmaster.opts", "pg_internal.init"]);
const manifestPath = "manifest.json";
const manifestLimit = 16 * 1024 ** 2;

export async function writeManagerArchive(
  context: ManagerContext,
  journal: ManagerCursor,
  output: string,
  maximum: number,
  operationId: string,
) {
  const directory = context.directory;
  const writer = context.sourceWriter();
  if (!directory || !writer) throw new Error("Manager backup requires a durable folder.");
  const archive = createArchiveOutput(output, [directory], context.validate, { bytes: maximum, members: 100_000 });
  async function tree(path: string) {
    await archive.directory(path);
    for (const name of readdirSync(join(directory as string, path)).sort()) {
      const member = `${path}/${name}`;
      const info = lstatSync(join(directory as string, member));
      if (info.isDirectory()) await tree(member);
      else if (!info.isFile()) throw new Error("Manager backup has a nonregular database entry.");
      else if (!skipped.has(name)) {
        const file = openSync(join(directory as string, member), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await archive.file(member, info.size, fileChunks(file, info.size, context.validate));
        } finally {
          closeSync(file);
        }
      }
    }
  }
  try {
    const inventory = await context.db.select().from(context.tables.accounts);
    const operations = await context.db.select().from(context.tables.operations);
    // This command owns the stopped manager's writer lock. The engine barrier also prevents queries during the copy.
    await context.client._runExclusiveTransaction(() => context.client.runExclusive(() => tree("db")));
    const manifest = ManagerManifestSchema.parse({
      format: "pocketcoder-manager-backup/v1",
      ...currentFormat,
      operationId,
      createdAt: new Date().toISOString(),
      journal,
      sourceWriter: writer,
      inventory: inventory.map((account) => ({
        id: account.id,
        namespace: account.namespace,
        state: account.state,
        operations: operations
          .filter((operation) => operation.accountId === account.id)
          .map((operation) => operation.id),
      })),
      members: [...archive.members],
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > manifestLimit) throw new Error("Manager backup inventory is too large.");
    await archive.file(
      manifestPath,
      bytes.length,
      (async function* () {
        yield bytes;
      })(),
    );
    return { ...(await archive.publish()), manifest };
  } finally {
    archive.discard();
  }
}

function exact(file: number, bytes: number, offset: number) {
  const buffer = Buffer.alloc(bytes);
  if (readSync(file, buffer, 0, bytes, offset) !== bytes) throw new Error("Manager archive is truncated.");
  return buffer;
}
type Member = ReturnType<typeof ManagerManifestSchema.parse>["members"][number];
type Header = NonNullable<ReturnType<typeof parseTarHeader>>;
function placement(member: Header, members: Member[], directories: Set<string>) {
  const parts = member.path.split("/");
  if (parts[0] !== "db" || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".."))
    throw new Error("Manager archive member path is unsafe.");
  if (members.some((prior) => prior.path === member.path)) throw new Error("Manager archive repeats a member.");
  if (parts.length > 1 && !directories.has(parts.slice(0, -1).join("/")))
    throw new Error("Manager archive parent is missing.");
}
async function extractMember(file: number, member: Header, offset: number, target?: string) {
  if (member.type === "directory") {
    if (target) mkdirSync(target, { mode: 0o700 });
    return { path: member.path, type: "directory" as const };
  }
  const hash = createHash("sha256");
  const destination = target
    ? openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    : undefined;
  try {
    for await (const chunk of fileChunks(file, member.size, () => {}, offset)) {
      hash.update(chunk);
      if (destination !== undefined) {
        let done = 0;
        while (done < chunk.length) done += writeSync(destination, chunk, done, chunk.length - done);
      }
    }
  } finally {
    if (destination !== undefined) closeSync(destination);
  }
  return { path: member.path, type: "file" as const, bytes: member.size, digest: `sha256:${hash.digest("hex")}` };
}
function readManifest(file: number, member: Header, offset: number) {
  if (member.type !== "file" || member.size > manifestLimit) throw new Error("Invalid manager backup manifest.");
  return ManagerManifestSchema.parse(JSON.parse(exact(file, member.size, offset).toString()));
}
export async function readManagerArchive(path: string, output?: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = lstatSync(path).size;
    const members: Member[] = [];
    const directories = new Set<string>();
    let manifest: ReturnType<typeof ManagerManifestSchema.parse> | undefined;
    let offset = 0;
    for (
      let member = parseTarHeader(exact(file, BLOCK, offset));
      member;
      member = parseTarHeader(exact(file, BLOCK, offset))
    ) {
      offset += BLOCK;
      if (manifest || offset + member.size > size)
        throw new Error("Manager archive has unexpected or incomplete members.");
      if (member.path === manifestPath) manifest = readManifest(file, member, offset);
      else {
        placement(member, members, directories);
        if (member.type === "directory") directories.add(member.path);
        members.push(await extractMember(file, member, offset, output && join(output, member.path)));
      }
      offset += member.size + tarPadding(member.size);
    }
    if (!manifest || offset + BLOCK * 2 !== size || parseTarHeader(exact(file, BLOCK, offset + BLOCK)))
      throw new Error("Manager archive end is invalid.");
    if (!isDeepStrictEqual(manifest.members, members)) throw new Error("Manager archive member checksums differ.");
    requireManagerFormat(manifest);
    return manifest;
  } finally {
    closeSync(file);
  }
}
