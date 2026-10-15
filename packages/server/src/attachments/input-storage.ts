import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  digestOf,
  type InputObjectReference,
  InputObjectReferenceSchema,
} from "@pstdio/pocketcoder-contracts";
import type {
  InputLimits,
  InputProjectionRef,
  InputStorageDriver,
  InputStore,
  ReadStorageCapacity,
  StoredInput,
} from "@pstdio/pocketcoder-runtime-core";

export interface InputStorageOptions {
  driver: InputStorageDriver;
  limits: InputLimits;
  capacity: ReadStorageCapacity;
}
export function inputBacking(row: StoredInput) {
  return { workspaceId: row.reference.workspaceId, fileId: row.reference.fileId, versionId: row.reservationId };
}
export class InputStorage {
  private readonly active = new Set<string>();
  constructor(
    private readonly store: InputStore,
    private readonly options: InputStorageOptions,
  ) {
    for (const value of Object.values(options.limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Explicit positive input limits are required.");
  }
  async upload(
    principalId: string,
    reference: InputObjectReference,
    deadline: Date,
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
  ) {
    reference = InputObjectReferenceSchema.parse(reference);
    const now = Date.now();
    const expiresAt = new Date(Math.min(deadline.getTime(), now + this.options.limits.transferMs));
    const claimed = await this.store.begin(
      {
        reference,
        principalId,
        reservationId: randomUUID(),
        transferExpiresAt: expiresAt,
        retentionMs: this.options.limits.retentionMs,
        retainedUntil: new Date(now + this.options.limits.retentionMs),
      },
      this.options.limits,
      this.options.capacity,
    );
    const row = claimed.row;
    if (!claimed.created) {
      await this.verify(row);
      return { reference: row.reference, created: false };
    }
    const ref = inputBacking(row);
    this.active.add(row.reservationId);
    const reader = body?.getReader();
    let writer: Awaited<ReturnType<InputStorageDriver["create"]>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectInterrupted: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupted = reject;
    });
    void interrupted.catch(() => {});
    const abort = () => {
      rejectInterrupted(new ApiError("attachment.interrupted", "Input transfer ended before publication."));
      void reader?.cancel().catch(() => {});
    };
    // The timer bounds body reads as well as idle uploads. Cleanup keeps the charge until deletion succeeds.
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(abort, Math.max(0, expiresAt.getTime() - Date.now()));
    try {
      writer = await this.options.driver.create(ref);
      let received = 0;
      const hash = createHash("sha256");
      while (reader) {
        // Cancellation can close the reader while storage opens. Preserve the earlier interruption.
        const { done, value } = await Promise.race([interrupted, reader.read()]);
        if (signal.aborted) throw new ApiError("attachment.interrupted", "Input transfer ended before publication.");
        if (done) break;
        received += value.byteLength;
        if (received > reference.sizeBytes)
          throw new ApiError("attachment.invalid", "Input exceeds its declared size.");
        await writer.write(value);
        hash.update(value);
      }
      if (received !== reference.sizeBytes || `sha256:${hash.digest("hex")}` !== reference.digest)
        throw new ApiError("attachment.invalid", "Input size or digest does not match its declaration.");
      if (signal.aborted || Date.now() >= expiresAt.getTime())
        throw new ApiError("attachment.interrupted", "Input transfer expired.");
      await writer.publish();
      await this.store.publish(reference.workspaceId, reference.fileId, row.reservationId);
      return { reference, created: true };
    } catch (error) {
      await writer?.close();
      this.active.delete(row.reservationId);
      // An expired lease fences any late publication before capacity can be reused.
      await this.cleanup(row, new Date(Math.max(Date.now(), expiresAt.getTime())));
      throw error;
    } finally {
      this.active.delete(row.reservationId);
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  private async verify(row: StoredInput) {
    if (row.state !== "ready") throw new ApiError("attachment.not_found", "Input is unavailable.");
    try {
      await this.options.driver.verify(inputBacking(row), row.reference);
    } catch {
      await this.store.unavailable(row.reference.workspaceId, row.reference.fileId);
      throw new ApiError("attachment.not_found", "Canonical input bytes are unavailable; stage a new ID.");
    }
  }
  async freeze(id: string, workspaceId: string, incarnationId: string, fileIds: string[]) {
    const row = await this.store.freeze(id, workspaceId, incarnationId, fileIds, new Date());
    const objects = [];
    // Pin first so a retention sweep cannot delete bytes between verification and dispatch.
    for (const reference of row.manifest.objects) {
      const stored = await this.store.get(workspaceId, reference.fileId);
      if (!stored) throw new ApiError("attachment.not_found", "Input is unavailable.");
      await this.verify(stored);
      objects.push({ reference, backing: inputBacking(stored) });
    }
    const active = await this.store.getManifest(id);
    if (!active || active.finalizedAt) throw new ApiError("operation.conflict", "Input manifest has been finalized.");
    return {
      kind: "immutable-inputs/v1",
      manifestId: id,
      manifest: row.manifest,
      objects,
    } satisfies InputProjectionRef;
  }
  finalize(id: string) {
    return this.store.finalize(id, new Date());
  }
  private async cleanup(row: StoredInput, at: Date) {
    const { workspaceId, fileId } = row.reference;
    if (this.active.has(row.reservationId)) return;
    if (!(await this.store.beginRelease(workspaceId, fileId, row.reservationId, at))) return;
    await this.options.driver.remove(inputBacking(row));
    await this.store.release(workspaceId, fileId, row.reservationId);
  }
  async purge(workspaceId: string) {
    const rows = (await this.store.list()).filter(
      (row) => row.reference.workspaceId === workspaceId && row.state !== "expired",
    );
    for (const row of rows) await this.cleanup(row, new Date());
    if ((await this.store.list()).some((row) => row.reference.workspaceId === workspaceId && row.state !== "expired"))
      throw new Error("Input pins, transfers or physical deletion remain pending.");
    await this.options.driver.pruneEmpty([]);
  }
  async reconcile(at = new Date()) {
    const rows = await this.store.list();
    for (const row of rows) {
      if (row.state === "ready")
        await this.verify(row).catch((error) => {
          if (!(error instanceof ApiError) || error.code !== "attachment.not_found") throw error;
        });
      await this.cleanup(row, at);
    }
    const owned = new Set(
      rows.filter((row) => row.state !== "expired").map((row) => JSON.stringify(inputBacking(row))),
    );
    for (const ref of await this.options.driver.list()) {
      if (owned.has(JSON.stringify(ref))) continue;
      // A new transfer may have claimed its ID after the sweep snapshot.
      const current = await this.store.get(ref.workspaceId, ref.fileId);
      if (current?.reservationId === ref.versionId && current.state !== "expired") continue;
      await this.options.driver.remove(ref);
    }
    await this.options.driver.pruneEmpty(
      (await this.store.list()).filter((row) => row.state === "uploading").map(inputBacking),
    );
  }
}

export function inputReference(
  workspaceId: string,
  fileId: string,
  name: string,
  mediaType: string,
  sizeBytes: number,
  digest: string,
) {
  const contents = { workspaceId, fileId, name, mediaType, sizeBytes, digest };
  return InputObjectReferenceSchema.parse({ ...contents, objectVersion: digestOf(contents), visibility: "ready" });
}
