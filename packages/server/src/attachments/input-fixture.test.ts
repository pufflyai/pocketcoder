import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { InputStorage, inputBacking, inputReference } from "./input-storage";

export async function inputFixture() {
  const f = await createPGliteFixture("pc-input", "disk");
  const workspace = await insertTestWorkspace(f, "inputs");
  const root = await mkdtemp(join(tmpdir(), "pc-private-inputs-"));
  const driver = new FilesystemInputStorage(root, []);
  // Small explicit fixture bounds; these are not deployment defaults.
  const limits = {
    fileBytes: 1024 * 1024,
    stagedBytes: 8 * 1024 * 1024,
    files: 16,
    transfers: 2,
    transferMs: 1000,
    retentionMs: 600_000,
  };
  const options = {
    driver,
    limits,
    capacity: async () => ({
      workspace: { bytes: limits.stagedBytes, files: limits.files },
      principal: { bytes: 16 * 1024 * 1024, files: 32 },
      instance: { bytes: 32 * 1024 * 1024, files: 64 },
      freeDisk: { bytes: 64 * 1024 * 1024, files: 128, headroomBytes: 0, headroomFiles: 0 },
    }),
  };
  const service = new InputStorage(f.store.inputs, options);
  const reference = (body = "original", fileId = randomUUID()) =>
    inputReference(
      workspace.id,
      fileId,
      "notes.txt",
      "text/plain",
      Buffer.byteLength(body),
      `sha256:${createHash("sha256").update(body).digest("hex")}`,
    );
  const upload = (body = "original", ref = reference(body)) =>
    service.upload(f.principal.id, ref, workspace.deadlineAt, new Response(body).body, new AbortController().signal);
  return {
    ...f,
    workspace,
    root,
    driver,
    limits,
    options,
    service,
    reference,
    upload,
    async dispose() {
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
