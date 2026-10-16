import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  const publisher = new FilesystemInputProjection({
    root,
    storage,
    privateRoots: [canonical],
    capacity: { bytes: 8_388_608, files: 64 },
  });
  const workspaceId = randomUUID();
  const scope = { workspaceId, projectionId: randomUUID() };
  const incarnationId: string = randomUUID();
  async function input(text = "original") {
    const fileId = randomUUID();
    const backing = { workspaceId, fileId, versionId: randomUUID() };
    const contents = {
      workspaceId,
      fileId,
      name: "../../logical-name.txt",
      mediaType: "text/plain" as const,
      sizeBytes: Buffer.byteLength(text),
      digest: `sha256:${Bun.CryptoHasher.hash("sha256", text, "hex")}`,
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
      kind: "immutable-inputs/v1" as const,
      manifestId: randomUUID(),
      manifest: { ...contents, digest: digestOf(contents) },
      objects,
    };
  }
  return {
    directory,
    root,
    canonical,
    storage,
    publisher,
    scope,
    incarnationId,
    input,
    selection,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
