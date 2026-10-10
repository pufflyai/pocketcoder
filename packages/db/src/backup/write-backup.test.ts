import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPGliteFixture } from "../test-fixtures";
import { KEY_NAMES } from "./manifest";
import { tarHeader } from "./tar";
import { verifyBackup } from "./verify-backup";
import { writeBackup } from "./write-backup";

// Each test opens two PGlite engines: the controller and the verifier's scratch copy.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const f = await createPGliteFixture("pc-backup-db", "disk");
  const out = await mkdtemp(join(tmpdir(), "pc-backup-out-"));
  cleanup.push(f.dispose, () => rm(out, { recursive: true, force: true }));
  const keys = Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
    (typeof KEY_NAMES)[number],
    Buffer
  >;
  const options = (output: string, signal = new AbortController().signal) => ({
    output,
    keys,
    signal,
    freeze: <T>(capture: (check: () => void) => Promise<T>) => capture(() => {}),
  });
  return { f, out, keys, options };
}

test("a backup holds the database at its snapshot point and verifies from outside the data folder", async () => {
  const { f, out, keys, options } = await setup();
  const output = join(out, "first.tar");
  const receipt = await writeBackup(f.context, options(output));
  await f.store.createPrincipal("after-backup", ["admin"], ["*"]);

  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(await readdir(out)).toEqual(["first.tar"]);
  const verified = await verifyBackup(output);
  expect(verified.manifest.snapshotId).toBe(receipt.snapshotId);
  expect(verified.manifest.database.position).toBe(receipt.position);
  expect(verified.manifest.members.some((member) => member.path === "db/PG_VERSION")).toBe(true);
  expect(verified.manifest.members.some((member) => member.path.endsWith("postmaster.pid"))).toBe(false);

  const extracted = join(out, "extracted");
  await Bun.$`mkdir ${extracted} && tar -xf ${output} -C ${extracted}`.quiet();
  expect((await readFile(join(extracted, "keys/secret-key"))).equals(keys["secret-key"])).toBe(true);
}, 30_000);

test("the archive never lands inside the data folder or over an existing file", async () => {
  const { f, out, options } = await setup();
  await expect(writeBackup(f.context, options(join(f.context.dataDir as string, "inside.tar")))).rejects.toThrow(
    "outside",
  );
  // A folder whose name starts with ".." is still inside the data folder.
  const dotted = join(f.context.dataDir as string, "..backups");
  await mkdir(dotted, { mode: 0o700 });
  await expect(writeBackup(f.context, options(join(dotted, "inside.tar")))).rejects.toThrow("outside");
  await writeFile(join(out, "taken.tar"), "keep");
  await expect(writeBackup(f.context, options(join(out, "taken.tar")))).rejects.toThrow("already exists");
  expect(await readFile(join(out, "taken.tar"), "utf8")).toBe("keep");
  expect(await readdir(out)).toEqual(["taken.tar"]);
}, 30_000);

test("an interrupted backup leaves no archive and no partial file", async () => {
  const { f, out, options } = await setup();
  const abort = new AbortController();
  const request = options(join(out, "interrupted.tar"), abort.signal);
  const pending = writeBackup(f.context, {
    ...request,
    freeze: async (capture) => {
      const result = await capture(() => {});
      abort.abort(new Error("caller left"));
      return result;
    },
  });
  await expect(pending).rejects.toThrow("caller left");
  expect(await readdir(out)).toEqual([]);
}, 30_000);

test("verification refuses a changed member", async () => {
  const { f, out, options } = await setup();
  const output = join(out, "changed.tar");
  await writeBackup(f.context, options(output));
  const bytes = await readFile(output);
  const at = bytes.indexOf(Buffer.from("keys/secret-key")) + 512;
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  await writeFile(output, bytes);
  await expect(verifyBackup(output)).rejects.toThrow("differ from the manifest");
}, 30_000);

test("verification refuses data after the end marker and members outside the format", async () => {
  const { f, out, options } = await setup();
  const output = join(out, "trailing.tar");
  await writeBackup(f.context, options(output));
  await appendFile(output, Buffer.alloc(512, 1));
  await expect(verifyBackup(output)).rejects.toThrow();

  const original = join(out, "renamed.tar");
  await writeBackup(f.context, options(original));
  const bytes = await readFile(original);
  // Rename keys/secret-key to keys/../escape in place; the header checksum is rewritten.
  const at = bytes.indexOf(Buffer.from("keys/secret-key"));
  const header = tarHeader({ path: "keys/../escape-k", type: "file", size: 32 });
  bytes.set(header, at);
  await writeFile(original, bytes);
  await expect(verifyBackup(original)).rejects.toThrow("unexpected member");
}, 30_000);
