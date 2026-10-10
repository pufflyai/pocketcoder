import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "./journal";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folders() {
  const root = await mkdtemp(join(tmpdir(), "pc-journal-"));
  roots.push(root);
  return { data: root, journal: join(root, "..", `${root.split("/").at(-1)}-journal`) };
}

const at = new Date().toISOString();
const keyId = crypto.randomUUID();

test("records survive reopening in order and one controller holds the journal", async () => {
  const { data, journal } = await folders();
  roots.push(journal);
  const first = openJournal(journal, data);
  expect(() => openJournal(journal, data)).toThrow("in use");
  first.append({ kind: "key_revoked", keyId, at });
  const head = first.append({ kind: "principal_disabled", principalId: keyId, keyIds: [keyId], at });
  first.close();

  const reopened = openJournal(journal, data);
  expect(reopened.id).toBe(first.id);
  expect(reopened.head()).toEqual(head);
  expect(reopened.records().map((record) => record.event.kind)).toEqual(["key_revoked", "principal_disabled"]);
  expect(reopened.at(1)?.digest).toBe(reopened.records()[0]?.digest);
  expect(reopened.at(3)).toBeNull();
  reopened.close();
});

test("an unfinished last line is dropped and an edited record is refused", async () => {
  const { data, journal } = await folders();
  roots.push(journal);
  const writer = openJournal(journal, data);
  writer.append({ kind: "key_revoked", keyId, at });
  writer.close();
  await appendFile(join(journal, "journal.log"), '{"sequence":2');
  const reopened = openJournal(journal, data);
  expect(reopened.head().sequence).toBe(1);
  reopened.close();

  const text = await readFile(join(journal, "journal.log"), "utf8");
  await writeFile(join(journal, "journal.log"), text.replace(keyId, crypto.randomUUID()));
  expect(() => openJournal(journal, data)).toThrow("chain is broken");
});

test("the journal cannot live inside the data folder", async () => {
  const { data } = await folders();
  expect(() => openJournal(join(data, "journal"), data)).toThrow("outside the data folder");
});
