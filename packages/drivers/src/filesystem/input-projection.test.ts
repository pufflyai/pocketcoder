import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { InputProjectionRef } from "@pstdio/pocketcoder-runtime-core";
import { FilesystemInputStorage } from "./filesystem-inputs";
import { FilesystemInputProjection } from "./input-projection";

export async function projectionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pc128-"));
  const root = join(directory, "projections");
  const canonical = join(directory, "canonical");
  const storage = new FilesystemInputStorage(canonical, [root]);
  const publisher = new FilesystemInputProjection({ root, storage, privateRoots: [canonical] });
  const workspaceId = randomUUID();
  const scope = { workspaceId, projectionId: randomUUID() };
  const incarnationId = randomUUID();
  async function input(text = "original") {
    const fileId = randomUUID();
    const backing = { workspaceId, fileId, versionId: randomUUID() };
    const contents = {
      workspaceId, fileId, name: "../../logical-name.txt", mediaType: "text/plain" as const,
      sizeBytes: Buffer.byteLength(text), digest: `sha256:${Bun.CryptoHasher.hash("sha256", text, "hex")}`,
    };
    const reference = { ...contents, objectVersion: digestOf(contents), visibility: "ready" as const };
    const writer = await storage.create(backing);
    await writer.write(Buffer.from(text));
    await writer.publish();
    return { reference, backing };
  }
  function selection(objects: InputProjectionRef["objects"]) {
    const contents = { workspaceId, incarnationId, objects: objects.map((item) => item.reference) };
    return {
      kind: "immutable-inputs/v1" as const, manifestId: randomUUID(),
      manifest: { ...contents, digest: digestOf(contents) }, objects,
    };
  }
  return { directory, root, canonical, storage, publisher, scope, incarnationId, input, selection,
    close: () => rm(directory, { recursive: true, force: true }) };
}

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
  } finally { await f.close(); }
});

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
    await symlink(join(f.canonical, object.backing.workspaceId, object.backing.fileId, object.backing.versionId, "payload"), path);
    await expect(f.publisher.publish(f.scope, f.incarnationId, selected)).rejects.toThrow();
    await rm(join(f.publisher.path(f.scope), selected.manifestId), { recursive: true, force: true });
    await writeFile(join(f.canonical, object.backing.workspaceId, object.backing.fileId, object.backing.versionId, "payload"), "modified");
    await expect(f.publisher.publish(f.scope, f.incarnationId, selected)).rejects.toThrow();
    expect(await Bun.file(join(f.publisher.path(f.scope), selected.manifestId, "manifest.json")).exists()).toBe(false);
  } finally { await f.close(); }
});
