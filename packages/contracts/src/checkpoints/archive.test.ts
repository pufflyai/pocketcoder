import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../common/canonical";
import { readCheckpointArchive } from "./archive-reader";

const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const data = Buffer.from("last committed content\n");

function tarMember(name: string, body: Buffer, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  for (const [offset, width, value] of [
    [100, 8, 0o600],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, body.length],
    [136, 12, 0],
  ] as const) {
    header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset);
  }
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function fixture(
  entryPatch: Record<string, unknown> = {},
  headerPatch: Record<string, unknown> = {},
  prefix: { header?: Buffer; entry?: Buffer } = {},
) {
  const header = {
    format: "pocketcoder-checkpoint-tar/v1" as const,
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: digest("template"),
    mounts: [{ name: "worktree", logical_bytes: data.length, file_count: 1 }],
    ...headerPatch,
  };
  const entry = {
    mount: 0,
    path: "long-☃/content.txt",
    kind: "file",
    mode: 0o640,
    mtime_ns: "123000000",
    size: data.length,
    digest: digest(data),
    ...entryPatch,
  };
  const document = Buffer.concat([prefix.header ?? Buffer.alloc(0), Buffer.from(canonicalJson(header))]);
  const record = Buffer.concat([prefix.entry ?? Buffer.alloc(0), Buffer.from(canonicalJson(entry))]);
  const manifest = createHash("sha256");
  const content = createHash("sha256");
  for (const value of [document, record]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    manifest.update(length).update(value);
    content.update(length).update(value);
  }
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(data.length));
  content.update(length).update(data);
  const summary = Buffer.from(
    canonicalJson({
      mounts: header.mounts,
      manifest_digest: `sha256:${manifest.digest("hex")}`,
      content_digest: `sha256:${content.digest("hex")}`,
    }),
  );
  const members = [
    tarMember("checkpoint.json", document),
    tarMember("entries/0000000000000000.json", record),
    tarMember("payload/0000000000000000/0000000000000000", data),
    tarMember("summary.json", summary),
  ];
  return { header, entry, members, archive: Buffer.concat([...members, Buffer.alloc(1024)]) };
}

function streamOf(chunks: AsyncIterable<Uint8Array>) {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function pieces(bytes: Buffer, size = 71) {
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
  }
  return streamOf(chunks());
}

test("reads mapped Unicode metadata and content across arbitrary tar boundaries", async () => {
  const f = fixture();
  const records: unknown[] = [];
  const chunks: Uint8Array[] = [];
  const result = await readCheckpointArchive(pieces(f.archive), {
    maxArchiveBytes: f.archive.length,
    onEntry: async (entry) => {
      records.push(entry);
    },
    onData: async (_entry, bytes) => {
      chunks.push(Buffer.from(bytes));
    },
  });
  expect(result.header).toEqual(f.header);
  expect(records).toEqual([f.entry]);
  expect(Buffer.concat(chunks)).toEqual(data);
  expect(result.archiveDigest).toBe(digest(f.archive));
  expect(result.archiveBytes).toBe(f.archive.length);
});

test.each(["../escape", "/absolute", "a//b", "a/./b", "a\\b", "a\0b", "e\u0301", "\ud800"])(
  "refuses unsafe metadata path %j before forwarding file bytes",
  async (path) => {
    const f = fixture({ path });
    let forwarded = 0;
    await expect(
      readCheckpointArchive(pieces(f.archive), {
        maxArchiveBytes: f.archive.length,
        onData: async () => {
          forwarded++;
        },
      }),
    ).rejects.toThrow("entry");
    expect(forwarded).toBe(0);
  },
);

test.each(["1", "2", "5", "x", "L", "S", "3", "4", "6"])("refuses raw tar type %s", async (type) => {
  const f = fixture();
  const body = Buffer.from(canonicalJson(f.header));
  const archive = Buffer.concat([tarMember("checkpoint.json", body, type), ...f.members.slice(1), Buffer.alloc(1024)]);
  await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow("header");
});

test.each([{ mode: 0o4640 }, { kind: "fifo" }, { uid: 0 }, { size: Number.MAX_SAFE_INTEGER + 1 }])(
  "refuses forbidden entry metadata %j",
  async (patch) => {
    const f = fixture(patch);
    await expect(readCheckpointArchive(pieces(f.archive), { maxArchiveBytes: f.archive.length })).rejects.toThrow(
      "entry",
    );
  },
);

test("rejects reserved byte/file overruns before forwarding payload", async () => {
  for (const mounts of [
    [{ name: "worktree", logical_bytes: data.length - 1, file_count: 1 }],
    [{ name: "worktree", logical_bytes: data.length, file_count: 0 }],
  ]) {
    const f = fixture({}, { mounts });
    let forwarded = 0;
    await expect(
      readCheckpointArchive(pieces(f.archive), {
        maxArchiveBytes: f.archive.length,
        onData: async () => {
          forwarded++;
        },
      }),
    ).rejects.toThrow("totals");
    expect(forwarded).toBe(0);
  }
});

test("rejects corrupted content, truncated bodies, bad padding, and trailing data", async () => {
  const f = fixture();
  const corrupted = Buffer.from(f.archive);
  const first = f.members.at(0);
  const second = f.members.at(1);
  if (!first || !second) throw new Error("Missing fixture members");
  const bodyOffset = first.length + second.length + 512;
  corrupted[bodyOffset] = data.readUInt8(0) ^ 1;
  const padding = Buffer.from(f.archive);
  padding[bodyOffset + data.length] = 1;
  for (const archive of [corrupted, padding, f.archive.subarray(0, -1), Buffer.concat([f.archive, Buffer.from([0])])]) {
    await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow();
  }
});

test("stops and drains the input when the archive exceeds its physical reservation", async () => {
  const f = fixture();
  let drained = false;
  async function* source() {
    try {
      yield f.archive;
    } finally {
      drained = true;
    }
  }
  await expect(readCheckpointArchive(streamOf(source()), { maxArchiveBytes: 1024 })).rejects.toThrow("reservation");
  expect(drained).toBe(true);
});

test("rejects duplicate or reordered metadata without retaining a whole-tree index", async () => {
  const f = fixture();
  for (const path of [f.entry.path, "before"]) {
    const record = tarMember("entries/0000000000000001.json", Buffer.from(canonicalJson({ ...f.entry, path })));
    const archive = Buffer.concat([...f.members.slice(0, 3), record, ...f.members.slice(3), Buffer.alloc(1024)]);
    await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow(
      "out of order",
    );
  }
});

test("rejects oversized or noncanonical metadata and unsupported header encodings", async () => {
  const f = fixture();
  const cases = [
    tarMember("checkpoint.json", Buffer.from(JSON.stringify(f.header))),
    tarMember("checkpoint.json", Buffer.from(` ${canonicalJson(f.header)}`)),
    tarMember("checkpoint.json", Buffer.concat([Buffer.from([0xff]), Buffer.from(canonicalJson(f.header))])),
    tarMember("checkpoint.json", Buffer.alloc(32 * 1024 + 1, 32)),
  ];
  const sizeEncoding = Buffer.from(f.members[0] ?? Buffer.alloc(0));
  sizeEncoding[124] = 0x80;
  cases.push(sizeEncoding);
  const checksum = Buffer.from(f.members[0] ?? Buffer.alloc(0));
  checksum[148] = 0;
  cases.push(checksum);
  for (const first of cases) {
    const archive = Buffer.concat([first, ...f.members.slice(1), Buffer.alloc(1024)]);
    await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow();
  }
  const record = tarMember("entries/0000000000000000.json", Buffer.alloc(16 * 1024 + 1, 32));
  const archive = Buffer.concat([f.members[0] ?? Buffer.alloc(0), record, ...f.members.slice(2), Buffer.alloc(1024)]);
  await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow(
    "size limit",
  );
});

test("rejects an unverified summary even when the archive has a valid tar checksum", async () => {
  const f = fixture();
  const footer = tarMember(
    "summary.json",
    Buffer.from(
      canonicalJson({ mounts: f.header.mounts, manifest_digest: digest("wrong"), content_digest: digest("wrong") }),
    ),
  );
  const archive = Buffer.concat([...f.members.slice(0, 3), footer, Buffer.alloc(1024)]);
  await expect(readCheckpointArchive(pieces(archive), { maxArchiveBytes: archive.length })).rejects.toThrow("summary");
});

test.each(["header", "entry"] as const)(
  "rejects a UTF-8 BOM in a %s even when the full archive digests match",
  async (kind) => {
    const f = fixture({}, {}, { [kind]: Buffer.from([0xef, 0xbb, 0xbf]) });
    await expect(readCheckpointArchive(pieces(f.archive), { maxArchiveBytes: f.archive.length })).rejects.toThrow(
      "document",
    );
  },
);
