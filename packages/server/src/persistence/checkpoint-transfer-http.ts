import { createHash } from "node:crypto";
import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import {
  createCheckpointArchivePublication,
  createVerifiedCheckpointArchive,
  openCheckpointArchivePublication,
} from "@pstdio/pocketcoder-db/checkpoints";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { ActiveCheckpointTransfer, TransferLifetime } from "./checkpoint-transfer-lifetime";

export type CheckpointRetentionLimits = NonNullable<
  Parameters<Store["checkpointTransfers"]["grantUpload"]>[0]["retentionLimits"]
>;

function credentialDigest(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new Error("Invalid checkpoint credential.");
  return createHash("sha256").update(header.slice(7)).digest();
}
function checkedSource(source: ReadableStream<Uint8Array>, context: ActiveCheckpointTransfer) {
  const reader = source.getReader();
  let released = false;
  function release() {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          await context.validate();
          const part = await reader.read();
          await context.validate();
          if (part.done) {
            release();
            controller.close();
          } else controller.enqueue(part.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          release();
          throw error;
        }
      },
      async cancel(reason) {
        try {
          if (!released) await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

async function closeUploadOwners(
  verified: Awaited<ReturnType<typeof createVerifiedCheckpointArchive>> | undefined,
  owner: ReturnType<typeof createCheckpointArchivePublication> | undefined,
  committed: boolean,
) {
  const results = await Promise.allSettled([verified?.close(), owner?.close(!committed)]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export function createCheckpointTransferHttp(
  store: Store,
  lifetime: TransferLifetime,
  directory: string,
  retentionLimits: CheckpointRetentionLimits,
) {
  async function claim(request: Request, operationId: string, direction: "upload" | "download") {
    const context = lifetime.active.get(request.headers.get("x-checkpoint-transfer-id") ?? "");
    if (!context || context.row.operationId !== operationId || context.row.direction !== direction || context.task)
      throw new Error("Checkpoint transfer request authority is invalid.");
    if (
      request.headers.get("x-pocketcoder-workspace") !== context.row.workspaceId ||
      request.headers.get("x-pocketcoder-connection") !== context.connection.connectionId ||
      request.headers.get("x-pocketcoder-epoch") !== String(context.row.connectionEpoch) ||
      request.headers.get("x-pocketcoder-operation") !== operationId
    )
      throw new Error("Checkpoint transfer request identity differs from its grant.");
    context.check();
    await store.checkpointTransfers.claim(
      {
        id: context.row.id,
        operationId,
        direction,
        workspaceId: context.row.workspaceId,
        connectionEpoch: context.row.connectionEpoch,
        grantDigest: credentialDigest(request),
      },
      context.check,
    );
    context.check();
    return context;
  }
  return {
    async handleUpload(request: Request, operationId: string) {
      let context: ActiveCheckpointTransfer;
      try {
        context = await claim(request, operationId, "upload");
      } catch {
        await request.body?.cancel().catch(() => {});
        return new Response(null, { status: 401 });
      }
      const abort = () => context.abort.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      context.cleanupVerified = false;
      context.task = (async () => {
        let verified: Awaited<ReturnType<typeof createVerifiedCheckpointArchive>> | undefined;
        let owner: ReturnType<typeof createCheckpointArchivePublication> | undefined;
        let committed = false;
        try {
          if (!request.body || !context.row.expectedArchiveBytes)
            throw new Error("Checkpoint archive request is empty.");
          if (!context.row.reservationId) throw new Error("Checkpoint physical reservation is unavailable.");
          const reservation = await store.storageReservations.get(context.row.reservationId);
          if (reservation?.state !== "reserved") throw new Error("Checkpoint physical reservation is unavailable.");
          verified = await createVerifiedCheckpointArchive(checkedSource(request.body, context), {
            directory,
            maxArchiveBytes: context.row.expectedArchiveBytes,
            maxIndexBytes: context.row.expectedArchiveBytes,
            maxAllocatedBytes: reservation.reservedBytes,
            signal: context.abort.signal,
            check: context.check,
            async authorizeHeader(header) {
              await context.validate();
              if (canonicalJson(header) !== canonicalJson(context.row.declaredHeader))
                throw new Error("Checkpoint header differs from its admitted declaration.");
            },
          });
          if (verified.receipt.archiveBytes !== context.row.expectedArchiveBytes)
            throw new Error("Checkpoint archive differs from its declared physical size.");
          await context.validate();
          const name = `${context.row.checkpointId}-${context.row.id}.tar`;
          owner = createCheckpointArchivePublication(
            directory,
            name,
            context.check,
            reservation.reservedBytes - verified.receipt.allocatedBytes,
          );
          await store.checkpointTransfers.stage(
            context.row.id,
            { stagePath: name, stageIdentity: owner.identity() },
            owner.validate,
          );
          await owner.write(verified);
          await context.validate();
          const identity = owner.publish();
          const receipt = verified.receipt;
          await verified.close();
          verified = undefined;
          await store.checkpointTransfers.publish(
            context.row.id,
            {
              summary: receipt.summary,
              archiveDigest: receipt.archiveDigest,
              storedBytes: receipt.archiveBytes,
              stagePath: name,
              stageIdentity: identity,
            },
            owner.validate,
            retentionLimits,
          );
          committed = true;
          await owner.close();
          context.published();
        } finally {
          request.signal.removeEventListener("abort", abort);
          await closeUploadOwners(verified, owner, committed);
          context.cleanupVerified = true;
        }
      })();
      try {
        await context.task;
        return new Response(null, { status: 201 });
      } catch (error) {
        await lifetime.cleanup(context, error);
        return new Response(null, { status: 409 });
      }
    },
    async handleDownload(request: Request, operationId: string) {
      let context: ActiveCheckpointTransfer;
      try {
        context = await claim(request, operationId, "download");
      } catch {
        return new Response(null, { status: 401 });
      }
      let owner: ReturnType<typeof openCheckpointArchivePublication> | undefined;
      let reader:
        | {
            read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
            cancel(reason?: unknown): Promise<void>;
            releaseLock(): void;
          }
        | undefined;
      let complete!: () => void;
      const task = new Promise<void>((resolve) => {
        complete = resolve;
      });
      context.task = task;
      let released = false;
      async function release() {
        if (released) return;
        released = true;
        try {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
          await owner?.close();
        } finally {
          complete();
        }
      }
      let received = 0;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => {
        controller?.error(context.abort.signal.reason);
        void release();
      };
      context.abort.signal.addEventListener("abort", abort, { once: true });
      try {
        const publication = await store.checkpointTransfers.publication(context.row.checkpointId);
        await context.validate();
        if (!publication?.stagePath || !publication.stageIdentity)
          throw new Error("Checkpoint archive publication is missing.");
        owner = openCheckpointArchivePublication(
          directory,
          publication.stagePath,
          publication.stageIdentity,
          context.check,
        );
        reader = owner.stream().getReader();
        const stream = new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
            },
            async pull(value) {
              try {
                await context.validate();
                const part = await reader?.read();
                await context.validate();
                if (!part || part.done) throw new Error("Checkpoint download ended before its declared bytes.");
                received += part.value.length;
                if (received > (context.row.storedBytes ?? 0))
                  throw new Error("Checkpoint download exceeded its declared bytes.");
                if (received === context.row.storedBytes) {
                  // Content-Length consumers need no extra pull after their final byte.
                  const eof = await reader?.read();
                  await context.validate();
                  if (!eof?.done) throw new Error("Checkpoint download has bytes after its declared end.");
                  await store.checkpointTransfers.downloaded(context.row.id, context.check);
                  await release();
                  value.enqueue(part.value);
                  value.close();
                } else value.enqueue(part.value);
              } catch (error) {
                await release();
                await lifetime.cleanup(context, error);
                value.error(error);
              }
            },
            async cancel(reason) {
              await release();
              await lifetime.cleanup(context, reason);
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(stream, {
          headers: { "content-type": "application/octet-stream", "content-length": String(context.row.storedBytes) },
        });
      } catch (error) {
        await release();
        await lifetime.cleanup(context, error);
        return new Response(null, { status: 409 });
      } finally {
        void task.finally(() => context.abort.signal.removeEventListener("abort", abort));
      }
    },
  };
}
