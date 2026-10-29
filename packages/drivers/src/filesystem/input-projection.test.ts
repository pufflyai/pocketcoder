import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { link, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilesystemInputProjection } from "./input-projection";
import { projectionFixture } from "./projection-fixture.test";

test("publishes an ordered selection, rebuilds loss and keeps later additions separate", async () => {
  const f = await projectionFixture();
  try {
    await f.publisher.prepare(f.scope);
    const first = await f.input();
    const second = await f.input("later");
    const selected = f.selection([second, first]);
    const published = await f.publisher.publish(f.scope, f.incarnationId, selected);
    const path = join(f.publisher.path(f.scope), selected.manifestId);
    expect(published.directory).toBe(`/run/pocketcoder/inputs/${selected.manifestId}`);
    expect(JSON.parse(await readFile(join(path, "manifest.json"), "utf8"))).toEqual(selected.manifest);
    expect(await readFile(join(path, first.reference.fileId), "utf8")).toBe("original");
    await f.publisher.publish(f.scope, f.incarnationId, f.selection([await f.input("new upload")]));
    expect(await f.publisher.publish(f.scope, f.incarnationId, selected)).toEqual(published);
    await rm(path, { recursive: true, force: true });
    await f.publisher.publish(f.scope, f.incarnationId, selected);
    expect(await readFile(join(path, first.reference.fileId), "utf8")).toBe("original");
    await f.publisher.remove(f.scope);
    await f.storage.verify(first.backing, first.reference);
  } finally {
    await f.close();
  }
});

test("receipts fence changed selections after restart and projection loss", async () => {
  const f = await projectionFixture();
  try {
    await f.publisher.prepare(f.scope);
    const first = f.selection([await f.input()]);
    await f.publisher.publish(f.scope, f.incarnationId, first);
    await rm(join(f.publisher.path(f.scope), first.manifestId), { recursive: true });
    const changed = { ...f.selection([await f.input("changed!")]), manifestId: first.manifestId };
    const restarted = new FilesystemInputProjection({
      root: f.root,
      storage: f.storage,
      privateRoots: [f.canonical],
      capacity: { bytes: 8_388_608, files: 64 },
    });
    await expect(restarted.publish(f.scope, f.incarnationId, changed)).rejects.toThrow("digest");
    await restarted.publish(f.scope, f.incarnationId, first);
    const another = { ...f.scope, projectionId: randomUUID() };
    await restarted.prepare(another);
    await restarted.publish(another, f.incarnationId, changed);
    await restarted.remove(f.scope);
    expect(
      JSON.parse(await readFile(join(restarted.path(another), first.manifestId, "manifest.json"), "utf8")),
    ).toEqual(changed.manifest);
  } finally {
    await f.close();
  }
});

test("hard links and missing canonical bytes never produce a verified publication", async () => {
  const f = await projectionFixture();
  try {
    await f.publisher.prepare(f.scope);
    const object = await f.input();
    const selected = f.selection([object]);
    await f.publisher.publish(f.scope, f.incarnationId, selected);
    const path = join(f.publisher.path(f.scope), selected.manifestId, object.reference.fileId);
    await link(path, join(f.directory, "alias"));
    await expect(f.publisher.publish(f.scope, f.incarnationId, selected)).rejects.toThrow("Invalid");
    await rm(join(f.canonical, object.backing.workspaceId), { recursive: true });
    await expect(f.publisher.publish(f.scope, f.incarnationId, f.selection([object]))).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("projection copies and durable receipts obey explicit byte and file ceilings", async () => {
  const f = await projectionFixture();
  try {
    const bounded = new FilesystemInputProjection({
      root: f.root,
      storage: f.storage,
      privateRoots: [f.canonical],
      capacity: { bytes: 8192, files: 4 },
    });
    await bounded.prepare(f.scope);
    const selected = f.selection([await f.input()]);
    await bounded.publish(f.scope, f.incarnationId, selected);
    await expect(bounded.publish(f.scope, f.incarnationId, f.selection([await f.input("later")]))).rejects.toThrow(
      "capacity",
    );
    await bounded.release(f.scope, selected.manifestId);
    await bounded.publish(f.scope, f.incarnationId, f.selection([await f.input("later")]));
    const tiny = new FilesystemInputProjection({
      root: f.root,
      storage: f.storage,
      privateRoots: [f.canonical],
      capacity: { bytes: 1, files: 64 },
    });
    const another = { ...f.scope, projectionId: randomUUID() };
    await tiny.prepare(another);
    await expect(tiny.publish(another, f.incarnationId, selected)).rejects.toThrow("capacity");
  } finally {
    await f.close();
  }
});

test("1, 5 and 20 concurrent publications stay within the configured capacity", async () => {
  for (const attempts of [1, 5, 20]) {
    const f = await projectionFixture();
    try {
      const capacity = { bytes: 8_388_608, files: 6 };
      const bounded = new FilesystemInputProjection({
        root: f.root,
        storage: f.storage,
        privateRoots: [f.canonical],
        capacity,
      });
      await bounded.prepare(f.scope);
      const object = await f.input();
      const started = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => bounded.publish(f.scope, f.incarnationId, f.selection([object]))),
      );
      const accepted = results.filter((result) => result.status === "fulfilled").length;
      expect(accepted).toBe(Math.min(2, attempts));
      for (const result of results)
        if (result.status === "rejected") expect(String(result.reason)).toContain("capacity");
      console.info(
        JSON.stringify({
          projectionAttempts: attempts,
          accepted,
          rejected: attempts - accepted,
          elapsedMs: Math.round(performance.now() - started),
          capacity,
        }),
      );
    } finally {
      await f.close();
    }
  }
}, 30_000);

test("rejects links, corrupt bytes, changed selections and wrong incarnations", async () => {
  const f = await projectionFixture();
  try {
    await f.publisher.prepare(f.scope);
    const object = await f.input();
    const selected = f.selection([object]);
    await expect(f.publisher.publish(f.scope, "another", selected)).rejects.toThrow("incarnation");
    await f.publisher.publish(f.scope, f.incarnationId, selected);
    const path = join(f.publisher.path(f.scope), selected.manifestId, object.reference.fileId);
    await rm(path);
    await symlink(
      join(f.canonical, object.backing.workspaceId, object.backing.fileId, object.backing.versionId, "payload"),
      path,
    );
    await expect(f.publisher.publish(f.scope, f.incarnationId, selected)).rejects.toThrow();
    await rm(join(f.publisher.path(f.scope), selected.manifestId), { recursive: true, force: true });
    await writeFile(
      join(f.canonical, object.backing.workspaceId, object.backing.fileId, object.backing.versionId, "payload"),
      "modified",
    );
    await expect(f.publisher.publish(f.scope, f.incarnationId, selected)).rejects.toThrow();
    expect(await Bun.file(join(f.publisher.path(f.scope), selected.manifestId, "manifest.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("release durably fences a publisher delayed before entering the filesystem owner", async () => {
  const f = await projectionFixture();
  try {
    await f.publisher.prepare(f.scope);
    const selected = f.selection([await f.input()]);
    // The transport can finish cancel while an ordinary publish is still in
    // driver inspection. Its later filesystem entry must observe this fence.
    await f.publisher.release(f.scope, selected.manifestId);
    const restarted = new FilesystemInputProjection({
      root: f.root,
      storage: f.storage,
      privateRoots: [f.canonical],
      capacity: { bytes: 8388608, files: 64 },
    });
    await expect(restarted.publish(f.scope, f.incarnationId, selected)).rejects.toThrow("released");
    expect(await Bun.file(join(f.publisher.path(f.scope), selected.manifestId, "manifest.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});
