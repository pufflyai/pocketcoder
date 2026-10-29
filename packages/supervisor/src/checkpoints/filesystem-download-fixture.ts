import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointArchiveEntry,
  type CheckpointArchiveHeader,
  type CheckpointArchiveRecord,
  writeCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";

export const checkpointDigest = (value: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function downloadFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-filesystem-download-")));
  const scratch = join(root, "scratch");
  const work = join(root, "work");
  const state = join(root, "state");
  for (const path of [scratch, work, state]) await mkdir(path, { mode: 0o700 });
  const existing = join(root, "existing");
  await writeFile(existing, "untouched");
  const bytes = Buffer.alloc(130_049, 47);
  const mtime = "1700000000123456789";
  const entries: CheckpointArchiveEntry[] = [
    {
      mount: 0,
      path: "a",
      kind: "file",
      mode: 0o444,
      mtime_ns: mtime,
      size: bytes.length,
      digest: checkpointDigest(bytes),
    },
    {
      mount: 0,
      path: "deadlink",
      kind: "symlink",
      mode: 0o777,
      mtime_ns: mtime,
      size: 7,
      digest: checkpointDigest("missing"),
      link_target: "missing",
    },
    { mount: 0, path: "z", kind: "directory", mode: 0o500, mtime_ns: mtime, size: 0 },
    { mount: 0, path: "z/empty", kind: "file", mode: 0o600, mtime_ns: mtime, size: 0, digest: checkpointDigest("") },
    {
      mount: 0,
      path: "z/link",
      kind: "symlink",
      mode: 0o777,
      mtime_ns: mtime,
      size: 4,
      digest: checkpointDigest("../a"),
      link_target: "../a",
    },
    { mount: 0, path: "z/ä", kind: "file", mode: 0o600, mtime_ns: mtime, size: 6, digest: checkpointDigest("nested") },
    { mount: 1, path: "a", kind: "file", mode: 0o400, mtime_ns: mtime, size: 9, digest: checkpointDigest("secondary") },
  ];
  const header: CheckpointArchiveHeader = {
    format: "pocketcoder-checkpoint-tar/v1",
    checkpoint_id: randomUUID(),
    workspace_id: randomUUID(),
    template_digest: checkpointDigest("template"),
    mounts: [
      { name: "worktree", logical_bytes: bytes.length + 17, file_count: 6 },
      { name: "state", logical_bytes: 9, file_count: 1 },
    ],
  };
  function payloadFor(entry: CheckpointArchiveEntry) {
    if (entry.mount === 1) return Buffer.from("secondary");
    if (entry.path === "a") return bytes;
    if (entry.path === "z/ä") return Buffer.from("nested");
    return Buffer.alloc(0);
  }
  function archive(records = entries, declaredHeader = header) {
    async function* source(): AsyncGenerator<CheckpointArchiveRecord> {
      for (const entry of records) {
        if (entry.kind !== "file") yield { entry };
        else yield { entry, payload: new Blob([payloadFor(entry)]).stream() };
      }
    }
    return writeCheckpointArchive(declaredHeader, source(), { maxArchiveBytes: 1_000_000 });
  }
  const originalWire = Buffer.from(await new Response(archive()).arrayBuffer());
  const binding = {
    source: {
      checkpointId: header.checkpoint_id,
      workspaceId: header.workspace_id,
      templateDigest: header.template_digest,
      archiveDigest: checkpointDigest(originalWire),
    },
    destination: { workspaceId: randomUUID(), operationId: randomUUID() },
  };
  async function boundArchive(records = entries, declaredHeader = header) {
    const wire = Buffer.from(await new Response(archive(records, declaredHeader)).arrayBuffer());
    return {
      stream: new Blob([wire]).stream(),
      binding: {
        ...binding,
        source: {
          ...binding.source,
          archiveDigest: checkpointDigest(wire),
        },
      },
    };
  }
  const mounts = [
    { parent: work, policy: { name: "worktree", target: "/workspace", maxFiles: 6, maxBytes: bytes.length + 17 } },
    { parent: state, policy: { name: "state", target: "/state", maxFiles: 1, maxBytes: 9 } },
  ];
  let admitted = true;
  const options = {
    directory: scratch,
    maxArchiveBytes: 1_000_000,
    maxIndexBytes: 1_000_000,
    maxLedgerBytes: 1_000_000,
    check() {
      if (!admitted) throw new Error("restore operation fenced");
    },
  };
  return {
    root,
    existing,
    scratch,
    work,
    state,
    bytes,
    entries,
    header,
    mtime,
    binding,
    mounts,
    options,
    archive,
    boundArchive,
    fence() {
      admitted = false;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
