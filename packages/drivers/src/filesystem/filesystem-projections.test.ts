import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { InputProjectionRef } from "@pstdio/pocketcoder-runtime-core";
import { FilesystemInputStorage } from "./filesystem-inputs";
import { FilesystemInputPublisher } from "./filesystem-projections";

test("publishes frozen inputs atomically, retries after restart, and preserves earlier executions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-publisher-"));
  try {
    const privateRoot = join(root, "canonical");
    const projectionRoot = join(root, "projections");
    const source = new FilesystemInputStorage(privateRoot, [projectionRoot]);
    const publisher = new FilesystemInputPublisher(projectionRoot, { maxBytes: 1024, maxFiles: 2 });
    const workspaceId = randomUUID();
    const bytes = Buffer.from("canonical input");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const reference = {
      workspaceId, fileId: randomUUID(), objectVersion: digest, digest,
      sizeBytes: bytes.length, name: "../../logical-name.txt", mediaType: "text/plain", visibility: "ready" as const,
    };
    const backing = { workspaceId, fileId: reference.fileId, versionId: randomUUID() };
    const writer = await source.create(backing);
    await writer.write(bytes);
    await writer.publish();
    const contents = { workspaceId, incarnationId: "fixture", objects: [reference] };
    const projection: InputProjectionRef = {
      kind: "immutable-inputs/v1", manifestId: randomUUID(),
      manifest: { ...contents, digest: digestOf(contents) }, objects: [{ reference, backing }],
    };
    const path = await publisher.publish(projection, source);
    expect(await readFile(join(path, reference.fileId), "utf8")).toBe(bytes.toString());
    const restarted = new FilesystemInputPublisher(projectionRoot, { maxBytes: 1024, maxFiles: 2 });
    expect(await restarted.publish(projection, source)).toBe(path);
    const later = { ...projection, manifestId: randomUUID() };
    expect(await restarted.publish(later, source)).not.toBe(path);
    expect(await readFile(join(path, reference.fileId), "utf8")).toBe(bytes.toString());
    await expect(restarted.publish({ ...projection, manifest: { ...projection.manifest, incarnationId: "changed" } }, source)).rejects.toThrow();
    await expect(new FilesystemInputPublisher(projectionRoot, { maxBytes: 1, maxFiles: 1 }).publish(later, source)).rejects.toThrow("bounds");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
