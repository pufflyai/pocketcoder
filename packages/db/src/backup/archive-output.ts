import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  write as writeCallback,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { syncDirectory } from "../database/data-folder";
import type { BackupMember } from "./manifest";
import { BLOCK, tarHeader, tarPadding } from "./tar";

function inside(root: string, path: string) {
  const rest = relative(realpathSync(root), path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

const write = promisify(writeCallback);

async function writeAll(file: number, bytes: Uint8Array) {
  for (let done = 0; done < bytes.length; ) done += (await write(file, bytes, done, bytes.length - done)).bytesWritten;
}

// Writes one archive into a private ".partial" file next to the output and links it
// into place only when complete, so the output name never holds a partial archive.
export function createArchiveOutput(output: string, excluded: string[], check: () => void) {
  const parent = realpathSync(dirname(resolve(output)));
  const target = join(parent, basename(output));
  for (const root of excluded)
    if (inside(root, parent)) throw new Error(`Backup output must be outside ${realpathSync(root)}.`);
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error(`Backup output already exists: ${target}`);
  const partial = join(parent, `.${basename(target)}.partial`);
  const file = openSync(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const owned = fstatSync(file);
  const archive = createHash("sha256");
  const members: BackupMember[] = [];
  let size = 0;
  let state: "open" | "published" | "closed" = "open";

  async function append(bytes: Uint8Array) {
    check();
    await writeAll(file, bytes);
    archive.update(bytes);
    size += bytes.length;
  }
  function removePartial() {
    const current = lstatSync(partial, { throwIfNoEntry: false });
    // Never unlink a name that another process put in place of ours.
    if (current && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(partial);
  }

  return {
    path: target,
    members,
    async directory(path: string) {
      await append(tarHeader({ path, type: "directory", size: 0 }));
      members.push({ path, type: "directory" });
    },
    async file(path: string, bytes: number, content: AsyncIterable<Uint8Array>) {
      await append(tarHeader({ path, type: "file", size: bytes }));
      const hash = createHash("sha256");
      let written = 0;
      for await (const chunk of content) {
        written += chunk.length;
        if (written > bytes) break;
        hash.update(chunk);
        await append(chunk);
      }
      if (written !== bytes) throw new Error(`Backup member changed size while copying: ${path}`);
      await append(new Uint8Array(tarPadding(bytes)));
      members.push({ path, type: "file", bytes, digest: `sha256:${hash.digest("hex")}` });
    },
    async publish() {
      await append(new Uint8Array(BLOCK * 2));
      fsyncSync(file);
      closeSync(file);
      state = "closed";
      check();
      // link() fails when the name exists, so publication never replaces a file.
      linkSync(partial, target);
      state = "published";
      removePartial();
      syncDirectory(parent);
      return { path: target, bytes: size, digest: `sha256:${archive.digest("hex")}` };
    },
    discard() {
      if (state === "published") return;
      if (state === "open") closeSync(file);
      state = "closed";
      removePartial();
    },
  };
}
export type ArchiveOutput = ReturnType<typeof createArchiveOutput>;
