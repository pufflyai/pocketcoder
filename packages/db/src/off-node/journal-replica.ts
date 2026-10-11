import { createHash } from "node:crypto";
import { type SourceWriter, SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import type { JournalSnapshot } from "../journal/acknowledgement";
import { JOURNAL_FORMAT, JournalCursorSchema, JournalRecordSchema } from "../journal/events";
import { sourceWriterIdentity } from "../recovery/source-writer";
import { open, seal } from "./encryption";
import { ObjectStorage, type ObjectStorageConfig, ObjectStorageError } from "./object-storage";

const SnapshotSchema = z.strictObject({
  format: z.literal("pocketcoder-remote-journal/v1"),
  head: JournalCursorSchema,
  records: z.array(JournalRecordSchema),
  writer: SourceWriterSchema,
});
const writerIdentity = (writer: SourceWriter) => sourceWriterIdentity(writer).replace(/^sha256:/, "");

export function journalBytes(snapshot: JournalSnapshot) {
  return Buffer.from(JSON.stringify({ format: "pocketcoder-remote-journal/v1", ...snapshot }));
}

export function parseJournalBytes(bytes: Uint8Array): JournalSnapshot {
  const raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  SnapshotSchema.parse(raw);
  let previous = createHash("sha256")
    .update(JSON.stringify({ format: JOURNAL_FORMAT, journalId: raw.head.journalId }))
    .digest("hex");
  for (const [index, record] of raw.records.entries()) {
    const digest = createHash("sha256")
      .update(JSON.stringify({ sequence: index + 1, previous, event: record.event }))
      .digest("hex");
    if (record.sequence !== index + 1 || record.previous !== previous || record.digest !== digest)
      throw new Error("Remote deletion journal chain is broken.");
    previous = digest;
  }
  if (raw.head.sequence !== raw.records.length || raw.head.digest !== previous)
    throw new Error("Remote deletion journal head is incomplete.");
  return { head: raw.head, records: raw.records, writer: raw.writer };
}

function covered(current: JournalSnapshot, snapshot: JournalSnapshot) {
  if (current.head.journalId !== snapshot.head.journalId || current.head.sequence > snapshot.head.sequence)
    throw new Error("Local journal does not cover the current remote journal.");
  const at = current.head.sequence ? snapshot.records[current.head.sequence - 1]?.digest : undefined;
  if (current.head.sequence && at !== current.head.digest) throw new Error("Local and remote journals disagree.");
}

export function createJournalReplica(config: ObjectStorageConfig, accountId: string, encryptionKey: Uint8Array) {
  const account = z.uuid().parse(accountId);
  if (encryptionKey.length !== 32) throw new Error("Off-node encryption requires a separate 32-byte key.");
  const storage = new ObjectStorage(config);
  const prefix = `accounts/${account}/journal/`;
  const ClaimSchema = z.strictObject({ generation: z.number().int().nonnegative(), snapshot: SnapshotSchema });
  const latest = async (folder: string) =>
    (await storage.versions(folder)).filter((item) => item.latest && !item.deleted);
  const read = async (key: string, versionId?: string) =>
    open(new Uint8Array(await (await storage.get(key, versionId)).arrayBuffer()), encryptionKey, key);
  async function putImmutable(key: string, bytes: Uint8Array) {
    try {
      if (!Buffer.from(await read(key)).equals(Buffer.from(bytes)))
        throw new Error("Immutable remote journal object differs.");
      return;
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 404) throw error;
    }
    await storage.put(key, seal(bytes, encryptionKey, key));
    if (!Buffer.from(await read(key)).equals(Buffer.from(bytes)))
      throw new Error("Remote journal object was not acknowledged.");
  }

  async function currentClaim() {
    const claims = (await latest(`${prefix}writers/`)).map((item) => {
      const match = /\/(\d+)-([a-f0-9]{64})\.enc$/.exec(item.key);
      if (!match) throw new Error("Unknown remote writer claim.");
      return { ...item, generation: Number(match[1]), identity: match[2] };
    });
    if (!claims.length) return null;
    const generation = claims.reduce((highest, item) => Math.max(highest, item.generation), 0);
    const selected = claims.filter((item) => item.generation === generation);
    if (selected.length !== 1) throw new Error("Remote writer claim is ambiguous.");
    const claim = selected[0];
    if (!claim) throw new Error("Remote writer claim is missing.");
    const raw = JSON.parse(Buffer.from(await read(claim.key, claim.versionId)).toString());
    ClaimSchema.parse(raw);
    const initial = parseJournalBytes(Buffer.from(JSON.stringify(raw.snapshot)));
    if (raw.generation !== generation || writerIdentity(initial.writer) !== claim.identity)
      throw new Error("Remote writer claim identity differs.");
    const folder = `${prefix}heads/${generation}-${claim.identity}/`;
    const heads = (await latest(folder)).map((item) => {
      const match = /\/(\d+)-([a-f0-9]{64})\.enc$/.exec(item.key);
      if (!match) throw new Error("Unknown remote journal head.");
      return { ...item, sequence: Number(match[1]), digest: match[2] };
    });
    const sequence = heads.reduce((highest, item) => Math.max(highest, item.sequence), initial.head.sequence);
    const top = heads.filter((item) => item.sequence === sequence);
    if (top.length > 1) throw new Error("Remote journal head is ambiguous.");
    let snapshot = initial;
    if (top[0]) {
      snapshot = parseJournalBytes(await read(top[0].key, top[0].versionId));
      if (
        snapshot.head.sequence !== sequence ||
        snapshot.head.digest !== top[0].digest ||
        writerIdentity(snapshot.writer) !== claim.identity
      )
        throw new Error("Remote journal head identity differs.");
      covered(initial, snapshot);
    }
    return { generation, folder, snapshot };
  }

  async function publish(snapshot: JournalSnapshot, generation: number) {
    parseJournalBytes(journalBytes(snapshot));
    const identity = writerIdentity(snapshot.writer);
    const key = `${prefix}heads/${generation}-${identity}/${snapshot.head.sequence}-${snapshot.head.digest}.enc`;
    await putImmutable(key, journalBytes(snapshot));
    const proved = await currentClaim();
    if (proved?.snapshot.head.digest !== snapshot.head.digest || writerIdentity(proved.snapshot.writer) !== identity)
      throw new Error("Remote journal did not acknowledge this writer and head.");
  }

  async function claim(snapshot: JournalSnapshot, generation: number) {
    const key = `${prefix}writers/${generation}-${writerIdentity(snapshot.writer)}.enc`;
    await putImmutable(
      key,
      Buffer.from(JSON.stringify({ generation, snapshot: JSON.parse(journalBytes(snapshot).toString()) })),
    );
  }

  return {
    current: async () => (await currentClaim())?.snapshot ?? null,
    async acknowledge(snapshot: JournalSnapshot): Promise<void> {
      const prior = await currentClaim();
      if (prior) {
        if (sourceWriterIdentity(prior.snapshot.writer) !== sourceWriterIdentity(snapshot.writer))
          throw new Error("This controller was replaced by an off-node restore.");
        covered(prior.snapshot, snapshot);
        if (prior.snapshot.head.digest === snapshot.head.digest) return;
      } else {
        const initial = snapshot.records[0]?.event;
        if (
          snapshot.records.length !== 1 ||
          initial?.kind !== "writer_claimed" ||
          sourceWriterIdentity(initial.writer) !== sourceWriterIdentity(snapshot.writer)
        )
          throw new Error("Remote journal is missing; refusing to replace its evidence.");
        await claim(snapshot, 0);
      }
      await publish(snapshot, prior?.generation ?? 0);
    },
    // The manager calls this only after durable admission fencing and a successful zero-compute proof.
    async transfer(snapshot: JournalSnapshot, previousWriter: SourceWriter): Promise<void> {
      const prior = await currentClaim();
      if (!prior) throw new Error("Remote deletion journal is missing.");
      if (sourceWriterIdentity(prior.snapshot.writer) === sourceWriterIdentity(snapshot.writer)) {
        covered(prior.snapshot, snapshot);
        if (prior.snapshot.head.digest !== snapshot.head.digest) await publish(snapshot, prior.generation);
        return;
      }
      if (sourceWriterIdentity(prior.snapshot.writer) !== sourceWriterIdentity(previousWriter))
        throw new Error("The source writer changed before restore.");
      covered(prior.snapshot, snapshot);
      await claim(snapshot, prior.generation + 1);
      await publish(snapshot, prior.generation + 1);
    },
  };
}
