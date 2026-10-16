import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AcceptedInputManifestSchema, canonicalJson, digestOf } from "@pstdio/pocketcoder-contracts";
import type { InputProjectionRef, InputStorageDriver } from "@pstdio/pocketcoder-runtime-core";
import { type ProjectionCapacity, requireProjectionCapacity } from "./projection-capacity";
import { verifyProjectionFile, writeProjectionFile } from "./projection-files";
import {
  assertDirectory,
  directory,
  inputId,
  overlaps,
  physicalPath,
  privateRoot,
  syncDirectory,
} from "./projection-paths";

export interface ProjectionScope {
  workspaceId: string;
  projectionId: string;
}
export const INPUT_PROJECTION_TARGET = "/run/pocketcoder/inputs";

// Only the controller calls this publisher. Canonical objects and receipts never enter a mount.
export class FilesystemInputProjection {
  readonly root: string;
  private readonly protectedRoots: string[];
  private work: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      root: string;
      storage: InputStorageDriver;
      privateRoots: string[];
      capacity: ProjectionCapacity;
    },
  ) {
    for (const value of Object.values(options.capacity))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Explicit positive projection capacity is required.");
    this.root = privateRoot(options.root);
    this.protectedRoots = options.privateRoots.map(privateRoot);
    if (this.protectedRoots.some((root) => overlaps(root, this.root)))
      throw new Error("Input projection and private storage must not overlap.");
  }
  private serialize<T>(work: () => Promise<T>) {
    const next = this.work.then(work, work);
    this.work = next.catch(() => {});
    return next;
  }
  path(scope: ProjectionScope) {
    return join(this.root, inputId(scope.workspaceId), inputId(scope.projectionId));
  }
  assertMountSource(path: string) {
    const physical = physicalPath(path);
    if ([this.root, ...this.protectedRoots].some((root) => overlaps(root, physical)))
      throw new Error("Workload mount aliases immutable input storage.");
  }
  prepare(scope: ProjectionScope) {
    return this.serialize(async () => {
      const path = this.path(scope);
      await directory(this.root);
      await directory(dirname(path));
      await directory(path, 0o755);
      return path;
    });
  }
  publish(scope: ProjectionScope, incarnationId: string, input: InputProjectionRef) {
    return this.serialize(() => this.publishSelection(scope, incarnationId, input));
  }
  private async publishSelection(scope: ProjectionScope, incarnationId: string, input: InputProjectionRef) {
    const manifest = await this.selection(scope, incarnationId, input);
    const root = this.path(scope);
    await assertDirectory(root);
    const contents = canonicalJson(manifest);
    const destination = join(root, input.manifestId);
    const published = {
      manifestId: input.manifestId,
      digest: manifest.digest,
      directory: `${INPUT_PROJECTION_TARGET}/${input.manifestId}`,
    };
    try {
      await lstat(destination);
      await this.receipt(scope, input);
      await this.verify(destination, input, contents);
      return published;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An existing partial projection is corruption, not permission to replace accepted entries.
      try {
        await lstat(destination);
        throw new Error("Incomplete input projection.");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
    }
    const staging = join(this.root, ".staging", scope.workspaceId, scope.projectionId);
    await directory(staging);
    // Partial copies stay outside the stable mount until the whole selection is verified.
    for (const orphan of await readdir(staging)) await rm(join(staging, orphan), { recursive: true, force: true });
    const receipts = join(this.root, ".receipts", scope.workspaceId, scope.projectionId);
    await directory(receipts);
    for (const orphan of await readdir(receipts))
      if (orphan.startsWith(".pending-")) await rm(join(receipts, orphan), { force: true });
    const receiptExists = await lstat(join(receipts, input.manifestId)).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    await requireProjectionCapacity(
      [root, receipts],
      {
        bytes:
          input.objects.reduce((total, object) => total + object.reference.sizeBytes, 0) +
          Buffer.byteLength(contents) * (receiptExists ? 1 : 2),
        files: input.objects.length + (receiptExists ? 1 : 2),
      },
      this.options.capacity,
    );
    await this.receipt(scope, input);
    const pending = join(staging, randomUUID());
    await directory(pending, 0o755);
    try {
      for (const object of input.objects) {
        await writeProjectionFile(
          join(pending, inputId(object.reference.fileId)),
          await this.options.storage.read(object.backing, object.reference),
        );
      }
      await writeProjectionFile(join(pending, "manifest.json"), new Blob([contents]).stream());
      await this.verify(pending, input, contents);
      await syncDirectory(pending);
      await rename(pending, destination);
      await syncDirectory(root);
      await syncDirectory(staging);
      return published;
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
  }
  private async selection(scope: ProjectionScope, incarnationId: string, input: InputProjectionRef) {
    const manifest = AcceptedInputManifestSchema.parse(input.manifest);
    if (
      input.kind !== "immutable-inputs/v1" ||
      manifest.workspaceId !== scope.workspaceId ||
      manifest.incarnationId !== incarnationId
    )
      throw new Error("Input projection workspace/incarnation mismatch.");
    inputId(input.manifestId);
    if (input.objects.length !== manifest.objects.length) throw new Error("Input projection selection mismatch.");
    for (const [index, object] of input.objects.entries()) {
      const reference = manifest.objects[index];
      if (
        canonicalJson(reference) !== canonicalJson(object.reference) ||
        object.backing.workspaceId !== scope.workspaceId ||
        object.backing.fileId !== reference?.fileId
      )
        throw new Error("Input projection backing mismatch.");
      await this.options.storage.verify(object.backing, object.reference);
    }
    return manifest;
  }
  private async receipt(scope: ProjectionScope, input: InputProjectionRef) {
    const manifest = input.manifest;
    const contents = canonicalJson(manifest);
    // The private receipt binds the execution ID even if the visible directory is lost.
    const receipts = join(this.root, ".receipts", scope.workspaceId, scope.projectionId);
    await directory(receipts);
    const receipt = join(receipts, input.manifestId);
    try {
      await lstat(receipt);
      await verifyProjectionFile(receipt, Buffer.byteLength(contents), digestOf(manifest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pending = join(receipts, `.pending-${randomUUID()}`);
      try {
        await writeProjectionFile(pending, new Blob([contents]).stream());
        await rename(pending, receipt);
        await syncDirectory(receipts);
      } finally {
        await rm(pending, { force: true });
      }
    }
  }
  private async verify(path: string, input: InputProjectionRef, contents: string) {
    await assertDirectory(path);
    const names = await readdir(path);
    if (names.length !== input.objects.length + 1) throw new Error("Unexpected input projection entries.");
    await verifyProjectionFile(join(path, "manifest.json"), Buffer.byteLength(contents), digestOf(input.manifest));
    for (const object of input.objects)
      await verifyProjectionFile(
        join(path, object.reference.fileId),
        object.reference.sizeBytes,
        object.reference.digest,
      );
  }
  remove(scope: ProjectionScope) {
    return this.serialize(async () => {
      await rm(this.path(scope), { recursive: true, force: true });
      await rm(join(this.root, ".receipts", scope.workspaceId, scope.projectionId), { recursive: true, force: true });
      await rm(join(this.root, ".staging", scope.workspaceId, scope.projectionId), { recursive: true, force: true });
    });
  }
  release(scope: ProjectionScope, manifestId: string) {
    return this.serialize(async () => {
      await rm(join(this.path(scope), inputId(manifestId)), { recursive: true, force: true });
    });
  }
  purge(workspaceId: string) {
    inputId(workspaceId);
    return this.serialize(async () => {
      for (const parent of [this.root, join(this.root, ".receipts"), join(this.root, ".staging")])
        await rm(join(parent, workspaceId), { recursive: true, force: true });
    });
  }
}
