import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkpointTransferFixture } from "./transfer-fixture.test";
import { createCheckpointTransfers } from "./transfers";

test("an upload grant cannot consume released physical storage authority", async () => {
  const f = await checkpointTransferFixture();
  try {
    const t = createCheckpointTransfers(f.context);
    const g = await t.grantUpload(
      f.input,
      () => f.capacity,
      () => {},
    );
    await f.store.storageReservations.beginRelease(f.input.reservationId, () => {});
    await f.store.storageReservations.release(f.input.reservationId, () => {
      if (existsSync(join(f.context.dataWriter!.directory, g.stagePath!))) throw new Error("stage remains");
    });
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("released");
    const claim = {
      id: g.id,
      operationId: g.operationId,
      workspaceId: g.workspaceId,
      direction: "upload" as const,
      connectionEpoch: g.connectionEpoch,
      grantDigest: f.input.grantDigest,
    };
    await expect(t.claim(claim, () => {})).rejects.toThrow("reservation");
    expect((await t.get(g.id))?.state).toBe("granted");
  } finally {
    await f.dispose();
  }
});

test("stored transfer and reservation principal cannot drift from the actual source owner together", async () => {
  const f = await checkpointTransferFixture();
  try {
    const t = createCheckpointTransfers(f.context);
    const g = await t.grantUpload(
      f.input,
      () => f.capacity,
      () => {},
    );
    const foreign = await f.store.createPrincipal("other-transfer-owner", ["admin"], ["*"]);
    await f.context.db.update(f.context.tables.checkpointTransfers).set({ principalId: foreign.id });
    await f.context.db.update(f.context.tables.storageReservations).set({ principalId: foreign.id });
    expect(g.principalId).toBe(f.principal.id);
    const claim = {
      id: g.id,
      operationId: g.operationId,
      workspaceId: g.workspaceId,
      direction: "upload" as const,
      connectionEpoch: g.connectionEpoch,
      grantDigest: f.input.grantDigest,
    };
    await expect(t.claim(claim, () => {})).rejects.toThrow("principal");
    expect((await t.get(g.id))?.state).toBe("granted");
  } finally {
    await f.dispose();
  }
});

test("a native infinite workspace deadline cannot authorize an upload grant", async () => {
  const f = await checkpointTransferFixture();
  try {
    const t = createCheckpointTransfers(f.context);
    await f.query(`UPDATE pocketcoder.workspaces SET deadline_at = 'infinity'::timestamptz WHERE id = $1`, [
      f.workspace.id,
    ]);
    await expect(
      t.grantUpload(
        f.input,
        () => f.capacity,
        () => {},
      ),
    ).rejects.toThrow("deadline");
    expect(await t.get(f.input.id)).toBeNull();
    expect(await f.store.storageReservations.get(f.input.reservationId)).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("a native microsecond reservation expiry mismatch cannot bind an upload claim", async () => {
  const f = await checkpointTransferFixture();
  try {
    const t = createCheckpointTransfers(f.context);
    const g = await t.grantUpload(
      f.input,
      () => f.capacity,
      () => {},
    );
    await f.query(
      `UPDATE pocketcoder.storage_reservations SET expires_at = expires_at + interval '1 microsecond' WHERE id = $1`,
      [f.input.reservationId],
    );
    const claim = {
      id: g.id,
      operationId: g.operationId,
      workspaceId: g.workspaceId,
      direction: "upload" as const,
      connectionEpoch: g.connectionEpoch,
      grantDigest: f.input.grantDigest,
    };
    await expect(t.claim(claim, () => {})).rejects.toThrow("reservation");
    expect((await t.get(g.id))?.state).toBe("granted");
  } finally {
    await f.dispose();
  }
});
