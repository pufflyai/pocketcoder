import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { checkpointTransferFixture } from "./transfer-fixture.test";
import { createCheckpointTransfers } from "./transfers";

test("upload grant and physical reservation commit together and the grant is consumed once", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const transfer = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    expect(transfer).toMatchObject({
      state: "granted",
      connectionEpoch: 3,
      reservationId: fixture.input.reservationId,
    });
    expect((await fixture.store.storageReservations.get(fixture.input.reservationId))?.reservedBytes).toBe(8192);
    const claim = {
      id: transfer.id,
      operationId: fixture.input.operationId,
      workspaceId: fixture.workspace.id,
      direction: "upload" as const,
      connectionEpoch: 3,
      grantDigest: fixture.input.grantDigest,
    };
    const settled = await Promise.allSettled([transfers.claim(claim, () => {}), transfers.claim(claim, () => {})]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await transfers.get(transfer.id)).toMatchObject({ state: "streaming", grantDigest: null });
  } finally {
    await fixture.dispose();
  }
});

test("a stale connection epoch cannot grant an upload or consume a valid current grant", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    await expect(
      transfers.grantUpload(
        { ...fixture.input, connectionEpoch: 2 },
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("authority");
    expect(await fixture.store.storageReservations.get(fixture.input.reservationId)).toBeNull();
    const transfer = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    await fixture.store.updateWorkspace(fixture.workspace.id, { connectionEpoch: 4 }, new Date());
    await expect(
      transfers.claim(
        {
          id: transfer.id,
          operationId: fixture.input.operationId,
          workspaceId: fixture.workspace.id,
          direction: "upload",
          connectionEpoch: 3,
          grantDigest: fixture.input.grantDigest,
        },
        () => {},
      ),
    ).rejects.toThrow("authority");
    expect((await transfers.get(transfer.id))?.state).toBe("granted");
  } finally {
    await fixture.dispose();
  }
});

test("purge refuses a previously granted upload without releasing its owned partial capacity", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const transfer = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    await fixture.context.db
      .update(fixture.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(fixture.context.tables.workspaces.id, fixture.workspace.id));
    await expect(
      transfers.claim(
        {
          id: transfer.id,
          operationId: fixture.input.operationId,
          workspaceId: fixture.workspace.id,
          direction: "upload",
          connectionEpoch: 3,
          grantDigest: fixture.input.grantDigest,
        },
        () => {},
      ),
    ).rejects.toThrow("authority");
    expect(
      (await fixture.store.storageReservations.usage(fixture.workspace.id, fixture.principal.id)).instance,
    ).toEqual({ bytes: 8192, files: 6 });
  } finally {
    await fixture.dispose();
  }
});
