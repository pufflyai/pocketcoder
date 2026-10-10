import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { syncDirectory } from "../database/data-folder";
import { lockWriterDescriptor } from "../database/writer-lock";
import {
  JOURNAL_FORMAT,
  type JournalCursor,
  type JournalEvent,
  JournalHeaderSchema,
  type JournalRecord,
  JournalRecordSchema,
} from "./events";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Resolves links in the part of the path that exists, so a path that is not created yet compares correctly.
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}

function nested(a: string, b: string) {
  const rest = relative(a, b);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function openLocked(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = realpathSync(directory);
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
    throw new Error(`Deletion journal folder must have mode 0700: ${dir}`);
  const lock = openSync(join(dir, "LOCK"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    lockWriterDescriptor(lock, dir);
  } catch (error) {
    closeSync(lock);
    throw new Error(`Deletion journal is in use by another controller: ${dir}`, { cause: error });
  }
  return { dir, lock };
}

// Reads complete lines. A line without its newline was never acknowledged, so it is dropped.
function readLines(file: number, path: string) {
  const text = readFileSync(path, "utf8");
  const end = text.lastIndexOf("\n") + 1;
  if (end !== Buffer.byteLength(text)) {
    ftruncateSync(file, Buffer.byteLength(text.slice(0, end)));
    fsyncSync(file);
  }
  return text.slice(0, end).split("\n").filter(Boolean);
}

// An append-only, hash-chained file of deletions and revocations, kept outside the data folder
// so a restored backup cannot roll it back. Records are fsynced before the change they describe.
export function openJournal(directory: string, dataDirectory: string, create = true) {
  const data = realpathSync(dataDirectory);
  const target = canonical(directory);
  if (nested(data, target) || nested(target, data))
    throw new Error("Deletion journal must be outside the data folder.");
  // A bound data folder must find its journal; a missing one is missing evidence.
  if (!create && !existsSync(join(target, "journal.log"))) throw new Error(`Deletion journal is missing at ${target}.`);
  const { dir, lock } = openLocked(target);
  const path = join(dir, "journal.log");
  const file = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(file).isFile()) throw new Error("Deletion journal file must be a regular file.");
    const lines = readLines(file, path);
    if (!lines.length) {
      if (!create) throw new Error(`Deletion journal is missing at ${dir}.`);
      const header = JSON.stringify({ format: JOURNAL_FORMAT, journalId: randomUUID() });
      writeSync(file, `${header}\n`);
      fsyncSync(file);
      syncDirectory(dir);
      lines.push(header);
    }
    const header = JournalHeaderSchema.parse(JSON.parse(lines[0] as string));
    const records: JournalRecord[] = [];
    const headerDigest = sha256(lines[0] as string);
    let digest = headerDigest;
    for (const line of lines.slice(1)) {
      const raw = JSON.parse(line);
      const record = JournalRecordSchema.parse(raw);
      // Hash the event as written; parsing may reorder its keys.
      const expected = sha256(JSON.stringify({ sequence: records.length + 1, previous: digest, event: raw.event }));
      if (record.sequence !== records.length + 1 || record.previous !== digest || record.digest !== expected)
        throw new Error("Deletion journal chain is broken.");
      records.push(record);
      digest = record.digest;
    }
    let closed = false;
    let broken = false;
    let length = fstatSync(file).size;
    return {
      id: header.journalId,
      directory: dir,
      head(): JournalCursor {
        return { journalId: header.journalId, sequence: records.length, digest };
      },
      // Returns the cursor at `sequence`, or null when this journal never reached it.
      at(sequence: number): JournalCursor | null {
        if (sequence > records.length) return null;
        const at = sequence === 0 ? headerDigest : (records[sequence - 1] as JournalRecord).digest;
        return { journalId: header.journalId, sequence, digest: at };
      },
      records: () => [...records],
      lastWriter() {
        for (let index = records.length - 1; index >= 0; index--) {
          const event = (records[index] as JournalRecord).event;
          if (event.kind === "writer_claimed") return event.writer;
        }
        return null;
      },
      append(event: JournalEvent) {
        if (closed) throw new Error("Deletion journal is closed.");
        if (broken) throw new Error("Deletion journal could not undo a failed write; restart the controller.");
        const sequence = records.length + 1;
        const record = {
          sequence,
          previous: digest,
          digest: sha256(JSON.stringify({ sequence, previous: digest, event })),
          event,
        };
        const line = Buffer.from(`${JSON.stringify(record)}\n`);
        try {
          for (let done = 0; done < line.length; ) done += writeSync(file, line, done);
          fsyncSync(file);
        } catch (error) {
          // A partial line would break the chain on the next open, so cut it off.
          try {
            ftruncateSync(file, length);
            fsyncSync(file);
          } catch {
            broken = true;
          }
          throw error;
        }
        length += line.length;
        records.push(record);
        digest = record.digest;
        return this.head();
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(file);
        closeSync(lock);
      },
    };
  } catch (error) {
    closeSync(file);
    closeSync(lock);
    throw error;
  }
}
export type DeletionJournal = ReturnType<typeof openJournal>;
