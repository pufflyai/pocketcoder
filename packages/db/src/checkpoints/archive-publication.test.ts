import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import { createCheckpointArchivePublication, openCheckpointArchivePublication } from "./archive-publication";
import { createVerifiedCheckpointArchive } from "./verified-archive";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-durable-archive-")));
  const id = randomUUID();
  const header = {
    format: "pocketcoder-checkpoint-tar/v1" as const,
    checkpoint_id: id,
    workspace_id: randomUUID(),
    template_digest: `sha256:${"b".repeat(64)}`,
    mounts: [],
  };
  async function* records() {}
  const raw = Buffer.from(
    await new Response(writeCheckpointArchive(header, records(), { maxArchiveBytes: 4096 })).arrayBuffer(),
  );
  const verified = await createVerifiedCheckpointArchive(new Blob([raw]).stream(), {
    directory,
    maxArchiveBytes: raw.length,
    maxIndexBytes: raw.length,
    check() {},
    async authorizeHeader() {},
  });
  return { directory, id, header, raw, verified, name: `${id}-${randomUUID()}.tar` };
}

test("native publication retains exact verified bytes and durable identity; download reopens without links", async () => {
  const f = await fixture();
  try {
    const owner = createCheckpointArchivePublication(f.directory, f.name, () => {});
    await owner.write(f.verified);
    const identity = owner.publish();
    expect(identity.size).toBe(String(f.raw.length));
    expect(identity.allocatedBytes).toBe(String(statSync(join(f.directory, f.name)).blocks * 512));
    expect(await readFile(join(f.directory, f.name))).toEqual(f.raw);
    await owner.close();
    await f.verified.close();
    expect(await readdir(f.directory)).toEqual([f.name]);
    const opened = openCheckpointArchivePublication(f.directory, f.name, identity, () => {});
    expect(Buffer.from(await new Response(opened.stream()).arrayBuffer())).toEqual(f.raw);
    await opened.close();
    expect(
      createHash("sha256")
        .update(await readFile(join(f.directory, f.name)))
        .digest("hex"),
    ).toBe(f.verified.receipt.archiveDigest.slice(7));
  } finally {
    await f.verified.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("publication cleanup removes only its held object and refuses changed bytes", async () => {
  const f = await fixture();
  try {
    const owner = createCheckpointArchivePublication(f.directory, f.name, () => {});
    await owner.write(f.verified);
    const identity = owner.publish();
    await owner.close();
    await writeFile(join(f.directory, f.name), Buffer.alloc(f.raw.length));
    expect(() => openCheckpointArchivePublication(f.directory, f.name, identity, () => {})).toThrow();
  } finally {
    await f.verified.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unpublished and failed uploads drain their owned stage", async () => {
  const f = await fixture();
  try {
    const owner = createCheckpointArchivePublication(f.directory, f.name, () => {});
    await owner.write(f.verified);
    await owner.close(true);
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.verified.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("native publication refuses a real write before sealing even when replay bytes were valid", async () => {
  const f = await fixture();
  let changed = false;
  const stage = join(f.directory, `.${f.name}.partial`);
  const owner = createCheckpointArchivePublication(f.directory, f.name, () => {
    if (!changed && existsSync(stage) && statSync(stage).size === f.raw.length) {
      changed = true;
      writeFileSync(stage, Buffer.alloc(f.raw.length, 9));
    }
  });
  try {
    await expect(owner.write(f.verified)).rejects.toThrow();
    expect(changed).toBe(true);
    expect(() => owner.publish()).toThrow();
  } finally {
    await owner.close(true);
    await f.verified.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
