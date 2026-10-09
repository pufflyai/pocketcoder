import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { checkpointDownloadFixture } from "./checkpoint-transfer-download.test";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

test("purge cancels a stalled upload before its deadline and releases the partial charge", async () => {
  const f = await checkpointHttpFixture();
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId).catch((error) => error);
    const grant = await f.grant;
    // The client sends part of the archive and then stops without closing the request.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(f.raw.subarray(0, 1024));
      },
    });
    const sending = fetch(grant.url, { method: "PUT", headers: f.headers(grant), body });
    while ((await f.store.checkpointTransfers.get(grant.transfer_id))?.state !== "streaming") await Bun.sleep(5);
    const started = Date.now();
    await f.service.cancel(f.workspace.id, new Set());
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await sending).status).toBe(409);
    expect(await pending).toBeInstanceOf(Error);
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    expect(transfer?.state).toBe("aborted");
    expect((await f.store.storageReservations.get(transfer?.reservationId ?? ""))?.state).toBe("released");
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a preserve that reaches its prepare step after purge cancel starts no transfer", async () => {
  const f = await checkpointHttpFixture();
  try {
    await f.service.cancel(f.workspace.id, new Set());
    await expect(f.service.preserve(f.workspace, f.checkpoint, f.operationId)).rejects.toThrow(
      "Workspace purge canceled the checkpoint transfer.",
    );
    expect(await f.store.checkpointTransfers.listUnsettled()).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("purging the source cancels a restore download of its checkpoint", async () => {
  const f = await checkpointDownloadFixture();
  try {
    const response = await fetch(f.grant.url, { headers: f.headers });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("download body missing");
    await f.service.cancel(f.workspace.id, new Set([f.checkpoint.id]));
    await reader.cancel().catch(() => {});
    const row = await f.store.checkpointTransfers.get(f.grant.transfer_id);
    expect(row?.state).toBe("aborted");
    expect(row?.grantDigest).toBeNull();
    const installed = {
      operation_id: f.operationId,
      transfer_id: f.grant.transfer_id,
      checkpoint_id: f.checkpoint.id,
      archive_digest: f.grant.source.archive_digest,
      phase: "installed" as const,
    };
    expect(await f.service.installed(f.connected.conn, installed)).toBe(false);
    expect((await fetch(f.grant.url, { headers: f.headers })).status).toBe(401);
  } finally {
    await f.dispose();
  }
});
