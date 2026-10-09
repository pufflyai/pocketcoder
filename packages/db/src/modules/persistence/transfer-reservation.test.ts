import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { checkpointTransferFixture } from "./transfer-fixture.test";
import { createCheckpointTransfers } from "./transfers";

test("native sub-millisecond reservation expiry changes invalidate the grant binding", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const grant = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    await fixture.query(
      "UPDATE pocketcoder.storage_reservations SET expires_at = expires_at + interval '1 microsecond' WHERE id = $1",
      [fixture.input.reservationId],
    );
    await expect(
      transfers.claim(
        {
          id: grant.id,
          operationId: grant.operationId,
          workspaceId: grant.workspaceId,
          direction: "upload",
          connectionEpoch: grant.connectionEpoch,
          grantDigest: fixture.input.grantDigest,
        },
        () => {},
      ),
    ).rejects.toThrow("reservation");
    expect((await transfers.get(grant.id))?.state).toBe("granted");
  } finally {
    await fixture.dispose();
  }
});

test("matching transfer and reservation principals must still own the source operation", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const grant = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    const other = await fixture.store.createPrincipal("foreign", ["admin"], ["*"]);
    const { checkpointTransfers, storageReservations } = fixture.context.tables;
    await fixture.context.db.transaction(async (tx) => {
      await tx.update(checkpointTransfers).set({ principalId: other.id }).where(eq(checkpointTransfers.id, grant.id));
      await tx
        .update(storageReservations)
        .set({ principalId: other.id })
        .where(eq(storageReservations.id, fixture.input.reservationId));
    });
    await expect(
      transfers.claim(
        {
          id: grant.id,
          operationId: grant.operationId,
          workspaceId: grant.workspaceId,
          direction: "upload",
          connectionEpoch: grant.connectionEpoch,
          grantDigest: fixture.input.grantDigest,
        },
        () => {},
      ),
    ).rejects.toThrow("principal");
    expect((await transfers.get(grant.id))?.state).toBe("granted");
  } finally {
    await fixture.dispose();
  }
});

test("a native infinite workspace deadline cannot authorize an upload grant", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    await fixture.query("UPDATE pocketcoder.workspaces SET deadline_at = 'infinity' WHERE id = $1", [
      fixture.workspace.id,
    ]);
    const transfers = createCheckpointTransfers(fixture.context);
    await expect(
      transfers.grantUpload(
        fixture.input,
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("authority");
    expect(await fixture.store.storageReservations.get(fixture.input.reservationId)).toBeNull();
    expect(await transfers.get(fixture.input.id)).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

test("released physical capacity cannot authorize consumption of an upload grant", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const grant = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    await fixture.store.storageReservations.beginRelease(fixture.input.reservationId, () => {});
    await fixture.store.storageReservations.release(fixture.input.reservationId, () => {
      fixture.context.validateStorage?.();
      if (existsSync(join(fixture.context.dataDir!, "staging", fixture.input.id)))
        throw new Error("Owned stage remains.");
    });
    await expect(
      transfers.claim(
        {
          id: grant.id,
          operationId: grant.operationId,
          workspaceId: grant.workspaceId,
          direction: "upload",
          connectionEpoch: grant.connectionEpoch,
          grantDigest: fixture.input.grantDigest,
        },
        () => {},
      ),
    ).rejects.toThrow("reservation");
    expect((await transfers.get(grant.id))?.state).toBe("granted");
    expect((await fixture.store.storageReservations.get(fixture.input.reservationId))?.state).toBe("released");
  } finally {
    await fixture.dispose();
  }
});

test("an upload cannot be granted without capacity for its raw archive file", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    await expect(
      transfers.grantUpload(
        { ...fixture.input, reservedFiles: 0 },
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("declaration");
    expect(await fixture.store.storageReservations.get(fixture.input.reservationId)).toBeNull();
    expect(await transfers.get(fixture.input.id)).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

for (const patch of [
  { state: "releasing" as const },
  { purpose: "attachment" as const },
  { reservedBytes: 1 },
  { reservedFiles: 0 },
  { expiresAt: new Date(0) },
]) {
  test(`claim refuses a reservation that no longer matches its grant: ${JSON.stringify(patch)}`, async () => {
    const fixture = await checkpointTransferFixture();
    try {
      const transfers = createCheckpointTransfers(fixture.context);
      const grant = await transfers.grantUpload(
        fixture.input,
        () => fixture.capacity,
        () => {},
      );
      const reservations = fixture.context.tables.storageReservations;
      await fixture.context.db.update(reservations).set(patch).where(eq(reservations.id, fixture.input.reservationId));
      await expect(
        transfers.claim(
          {
            id: grant.id,
            operationId: grant.operationId,
            workspaceId: grant.workspaceId,
            direction: "upload",
            connectionEpoch: grant.connectionEpoch,
            grantDigest: fixture.input.grantDigest,
          },
          () => {},
        ),
      ).rejects.toThrow("reservation");
      expect((await transfers.get(grant.id))?.state).toBe("granted");
    } finally {
      await fixture.dispose();
    }
  });
}
