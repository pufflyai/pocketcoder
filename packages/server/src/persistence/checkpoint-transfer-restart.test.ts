import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

test("restart refuses a committed checkpoint whose archive is missing", async () => {
  const f = await checkpointHttpFixture();
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const grant = await f.grant;
    expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
    const checkpoint = await pending;
    await unlink(join(f.directory, String(checkpoint.providerRef?.archivePath)));
    expect(await f.service.reconcile()).toBe(0);
    expect((await f.store.getCheckpoint(checkpoint.id))?.state).toBe("failed");
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    expect((await f.store.storageReservations.get(transfer?.reservationId ?? ""))?.state).toBe("committed");
  } finally {
    await f.dispose();
  }
});
