import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { checkpointTransferFixture } from "./transfer-fixture.test";
import { createCheckpointTransfers } from "./transfers";

test("controller recovery closes new upload grants and previously issued grants", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const grant = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    const table = fixture.context.tables.controllerState;
    await fixture.context.db
      .update(table)
      .set({
        recovery: {
          format: "pocketcoder-recovery/v1",
          recoveryId: randomUUID(),
          reason: "journal_recovery",
          snapshotId: null,
          sourceCursor: null,
          journalReplay: null,
          createdAt: new Date().toISOString(),
        },
      })
      .where(eq(table.id, "controller"));
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
    ).rejects.toThrow("recovery");
    const reservationId = randomUUID();
    await expect(
      transfers.grantUpload(
        { ...fixture.input, id: randomUUID(), reservationId },
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("recovery");
    expect(await fixture.store.storageReservations.get(reservationId)).toBeNull();
    expect((await transfers.get(grant.id))?.state).toBe("granted");
  } finally {
    await fixture.dispose();
  }
});

test("a retired native controller folder cannot issue checkpoint upload authority", async () => {
  const fixture = await checkpointTransferFixture();
  const marker = join(fixture.context.dataDir!, "RETIRED");
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    await writeFile(marker, "closed", { flag: "wx", mode: 0o600 });
    await expect(
      transfers.grantUpload(
        fixture.input,
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("retired");
  } finally {
    await rm(marker);
    await fixture.dispose();
  }
});

test("a grant insert failure rolls back its physical reservation", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const wide = {
      workspace: { bytes: 30_000, files: 30 },
      principal: { bytes: 30_000, files: 30 },
      instance: { bytes: 30_000, files: 30 },
      freeDisk: { bytes: 40_000, files: 40, headroomBytes: 10_000, headroomFiles: 10 },
    };
    await transfers.grantUpload(
      fixture.input,
      () => wide,
      () => {},
    );
    const reservationId = randomUUID();
    const failure = await transfers
      .grantUpload(
        { ...fixture.input, reservationId },
        () => wide,
        () => {},
      )
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(failure?.cause).toMatchObject({ code: "23505" });
    expect(await fixture.store.storageReservations.get(reservationId)).toBeNull();
    expect(
      (await fixture.store.storageReservations.usage(fixture.workspace.id, fixture.principal.id)).instance,
    ).toEqual({ bytes: 8192, files: 6 });
  } finally {
    await fixture.dispose();
  }
});

test("expiry during the actual grant insert rolls back the grant and reservation", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    await fixture.query(`CREATE FUNCTION pocketcoder.delay_transfer_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END; $$`);
    await fixture.query(`CREATE TRIGGER delay_transfer_insert BEFORE INSERT ON pocketcoder.checkpoint_transfers
      FOR EACH ROW EXECUTE FUNCTION pocketcoder.delay_transfer_insert()`);
    const input = { ...fixture.input, expiresAt: new Date(Date.now() + 350) };
    await expect(
      transfers.grantUpload(
        input,
        () => fixture.capacity,
        () => {},
      ),
    ).rejects.toThrow("expired");
    expect(await transfers.get(input.id)).toBeNull();
    expect(await fixture.store.storageReservations.get(input.reservationId)).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

test("invalid direction, operation, epoch and digest cannot consume a valid grant", async () => {
  const fixture = await checkpointTransferFixture();
  try {
    const transfers = createCheckpointTransfers(fixture.context);
    const grant = await transfers.grantUpload(
      fixture.input,
      () => fixture.capacity,
      () => {},
    );
    const claim = {
      id: grant.id,
      operationId: grant.operationId,
      workspaceId: grant.workspaceId,
      direction: "upload" as const,
      connectionEpoch: grant.connectionEpoch,
      grantDigest: fixture.input.grantDigest,
    };
    for (const patch of [
      { direction: "download" as const },
      { operationId: randomUUID() },
      { connectionEpoch: 2 },
      { grantDigest: Buffer.alloc(32, 8) },
    ]) {
      await expect(transfers.claim({ ...claim, ...patch }, () => {})).rejects.toThrow("authority");
      expect((await transfers.get(grant.id))?.state).toBe("granted");
    }
    await transfers.claim(claim, () => {});
    expect((await transfers.get(grant.id))?.grantDigest).toBeNull();
  } finally {
    await fixture.dispose();
  }
});
