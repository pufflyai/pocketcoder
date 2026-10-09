import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createFilesystemCheckpointDownload } from "./filesystem-download";
import { checkpointDigest, downloadFixture } from "./filesystem-download-fixture";

test("real two-mount HTTP download returns sealed owned stages before any runtime cutover", async () => {
  const f = await downloadFixture();
  const token = randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      return new Response(f.archive());
    },
  });
  try {
    const response = await fetch(server.url, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Expected HTTP archive body");
    const prepared = await createFilesystemCheckpointDownload(response.body, f.binding, f.mounts, f.options);
    try {
      expect(f.binding.destination.workspaceId).not.toBe(f.header.workspace_id);
      expect(prepared.receipt.header).toEqual(f.header);
      expect(prepared.mounts.map((mount) => mount.name)).toEqual(["worktree", "state"]);
      const work = prepared.mounts[0]?.path;
      const state = prepared.mounts[1]?.path;
      if (!work || !state) throw new Error("Expected both prepared mounts");
      expect(await readFile(join(work, "a"))).toEqual(f.bytes);
      expect(await readFile(join(work, "z", "ä"), "utf8")).toBe("nested");
      expect(await readFile(join(state, "a"), "utf8")).toBe("secondary");
      expect(await readlink(join(work, "z", "link"))).toBe("../a");
      expect(await readlink(join(work, "deadlink"))).toBe("missing");
      expect((await lstat(join(work, "z", "empty"))).size).toBe(0);
      for (const [path, mode] of [
        [join(work, "a"), 0o444],
        [join(work, "z"), 0o500],
        [join(state, "a"), 0o400],
      ] as const) {
        const facts = await lstat(path, { bigint: true });
        expect(Number(facts.mode & 0o777n)).toBe(mode);
        expect(facts.mtimeNs.toString()).toBe(f.mtime);
      }
      expect(Object.isFrozen(prepared.mounts)).toBe(true);
      expect(await readFile(f.existing, "utf8")).toBe("untouched");
      prepared.validate();
      await prepared.verify();
      const checked = await lstat(join(work, "z"), { bigint: true });
      expect(checked.mode & 0o777n).toBe(0o500n);
      expect(checked.mtimeNs.toString()).toBe(f.mtime);
    } finally {
      await prepared.close();
    }
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("wrong source authority refuses before creating any destination stage", async () => {
  const f = await downloadFixture();
  try {
    await expect(
      createFilesystemCheckpointDownload(
        f.archive(),
        {
          ...f.binding,
          source: { ...f.binding.source, workspaceId: f.binding.destination.workspaceId },
        },
        f.mounts,
        f.options,
      ),
    ).rejects.toThrow("source");
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("late link cycle validates the complete graph before destination creation", async () => {
  const f = await downloadFixture();
  try {
    const entries = f.entries.map((entry) => {
      if (entry.path === "deadlink" && entry.kind === "symlink")
        return { ...entry, link_target: "z/link", size: 6, digest: checkpointDigest("z/link") };
      if (entry.path === "z/link" && entry.kind === "symlink")
        return { ...entry, link_target: "../deadlink", size: 11, digest: checkpointDigest("../deadlink") };
      return entry;
    });
    const header = {
      ...f.header,
      mounts: f.header.mounts.map((mount, index) =>
        index === 0 ? { ...mount, logical_bytes: mount.logical_bytes + 6 } : mount,
      ),
    };
    const mounts = f.mounts.map((mount, index) =>
      index === 0 ? { ...mount, policy: { ...mount.policy, maxBytes: mount.policy.maxBytes + 6 } } : mount,
    );
    await expect(
      createFilesystemCheckpointDownload(f.archive(entries, header), f.binding, mounts, f.options),
    ).rejects.toThrow("cycle");
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("corrupt final archive bytes never create a destination entry", async () => {
  const f = await downloadFixture();
  try {
    const wire = Buffer.from(await new Response(f.archive()).arrayBuffer());
    wire[wire.length - 1] = 1;
    await expect(
      createFilesystemCheckpointDownload(new Blob([wire]).stream(), f.binding, f.mounts, f.options),
    ).rejects.toThrow("end");
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("unsupported native timestamps fail before creating any destination stage", async () => {
  const f = await downloadFixture();
  try {
    const entries = f.entries.map((entry) => ({ ...entry, mtime_ns: "9223372036854775808000000000" }));
    const source = await f.boundArchive(entries);
    await expect(
      createFilesystemCheckpointDownload(source.stream, source.binding, f.mounts, f.options),
    ).rejects.toThrow("timestamp");
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("valid archive bytes must match the recorded source digest before destination creation", async () => {
  const f = await downloadFixture();
  let prepared: Awaited<ReturnType<typeof createFilesystemCheckpointDownload>> | undefined;
  try {
    const entries = f.entries.map((entry) =>
      entry.kind === "file" && entry.mount === 0 && entry.path === "a" ? { ...entry, mode: 0o400 } : entry,
    );
    let refusal: unknown;
    try {
      prepared = await createFilesystemCheckpointDownload(f.archive(entries), f.binding, f.mounts, f.options);
    } catch (error) {
      refusal = error;
    }
    const observed = await readdir(f.work);
    await prepared?.close();
    expect(observed).toEqual([]);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("digest");
    expect(await readdir(f.state)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await prepared?.close();
    await f.close();
  }
});
