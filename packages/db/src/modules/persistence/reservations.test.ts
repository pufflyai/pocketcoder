import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";
import { createStorageReservations } from "./reservations";

const limits = {
  workspace: { bytes: 100, files: 10 },
  principal: { bytes: 100, files: 10 },
  instance: { bytes: 100, files: 10 },
  freeDisk: { bytes: 200, files: 20, headroomBytes: 100, headroomFiles: 10 },
};

test("concurrent storage admissions cannot both reserve the last physical capacity", async () => {
  const fixture = await createPGliteFixture("storage-reservation", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "reserved");
    const reservations = createStorageReservations(fixture.context);
    const reserve = () =>
      reservations.reserve(
        {
          id: randomUUID(),
          purpose: "attachment",
          operationId: null,
          workspaceId: workspace.id,
          principalId: fixture.principal.id,
          reservedBytes: 60,
          reservedFiles: 6,
          expiresAt: new Date(Date.now() + 30_000),
        },
        () => limits,
        () => {},
      );
    const results = await Promise.allSettled([reserve(), reserve()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await reservations.usage(workspace.id, fixture.principal.id)).toEqual({
      workspace: { bytes: 60, files: 6 },
      principal: { bytes: 60, files: 6 },
      instance: { bytes: 60, files: 6 },
      outstanding: { bytes: 60, files: 6 },
    });
  } finally {
    await fixture.dispose();
  }
});

test("partial storage stays charged through cleanup and releases only after native absence", async () => {
  const fixture = await createPGliteFixture("storage-partial", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "partial");
    const reservations = createStorageReservations(fixture.context);
    const id = randomUUID();
    await reservations.reserve(
      {
        id,
        purpose: "attachment",
        operationId: null,
        workspaceId: workspace.id,
        principalId: fixture.principal.id,
        reservedBytes: 60,
        reservedFiles: 6,
        expiresAt: new Date(Date.now() + 30_000),
      },
      () => limits,
      () => {},
    );
    const file = join(fixture.context.dataDir!, "actual-partial");
    await writeFile(file, Buffer.alloc(16), { mode: 0o600, flag: "wx" });
    await reservations.materialize(id, { bytes: 16, files: 1 }, () => {});
    await reservations.beginRelease(id, () => {});
    const checkRemoved = () => {
      if (existsSync(file)) throw new Error("Owned file remains.");
    };
    await expect(reservations.release(id, checkRemoved)).rejects.toThrow("remains");
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance).toEqual({ bytes: 60, files: 6 });
    expect((await reservations.get(id))?.state).toBe("releasing");
    await rm(file);
    await reservations.release(id, checkRemoved);
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance).toEqual({ bytes: 0, files: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("free-disk admission counts only unwritten promises while committed bytes remain in instance usage", async () => {
  const fixture = await createPGliteFixture("storage-free-disk", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "committed");
    const reservations = createStorageReservations(fixture.context);
    const input = {
      id: randomUUID(),
      purpose: "attachment" as const,
      operationId: null,
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      reservedBytes: 60,
      reservedFiles: 6,
      expiresAt: new Date(Date.now() + 30_000),
    };
    await reservations.reserve(
      input,
      () => limits,
      () => {},
    );
    await reservations.materialize(input.id, { bytes: 30, files: 1 }, () => {});
    await reservations.commit(input.id, () => {});
    expect((await reservations.usage(workspace.id, fixture.principal.id)).outstanding).toEqual({ bytes: 0, files: 0 });
    const measured = { ...limits, freeDisk: { bytes: 120, files: 20, headroomBytes: 100, headroomFiles: 10 } };
    await reservations.reserve(
      { ...input, id: randomUUID(), reservedBytes: 20, reservedFiles: 1 },
      () => measured,
      () => {},
    );
    await expect(
      reservations.reserve(
        { ...input, id: randomUUID(), reservedBytes: 1, reservedFiles: 1 },
        () => measured,
        () => {},
      ),
    ).rejects.toThrow("free-disk headroom");
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance).toEqual({ bytes: 50, files: 2 });
  } finally {
    await fixture.dispose();
  }
});

test("a reservation queued behind a real transaction rechecks expiration after the lock", async () => {
  const fixture = await createPGliteFixture("storage-expiry", "disk");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const workspace = await insertTestWorkspace(fixture, "expired");
    const reservations = createStorageReservations(fixture.context);
    const holder = fixture.context.db.transaction(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const expiresAt = new Date(Date.now() + 25);
    const pending = reservations.reserve(
      {
        id: randomUUID(),
        purpose: "attachment",
        operationId: null,
        workspaceId: workspace.id,
        principalId: fixture.principal.id,
        reservedBytes: 60,
        reservedFiles: 6,
        expiresAt,
      },
      () => limits,
      () => {},
    );
    const result = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await Bun.sleep(40);
    release.resolve();
    await holder;
    expect(await result).toContain("expired");
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance).toEqual({ bytes: 0, files: 0 });
  } finally {
    release.resolve();
    await fixture.dispose();
  }
});

test("expiration during the actual reservation insert rolls the capacity claim back", async () => {
  const fixture = await createPGliteFixture("storage-insert-expiry", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "insert-expired");
    const reservations = createStorageReservations(fixture.context);
    await fixture.query(`CREATE FUNCTION pocketcoder.delay_storage_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END; $$`);
    await fixture.query(`CREATE TRIGGER delay_storage_insert BEFORE INSERT ON pocketcoder.storage_reservations
      FOR EACH ROW EXECUTE FUNCTION pocketcoder.delay_storage_insert()`);
    await expect(
      reservations.reserve(
        {
          id: randomUUID(),
          purpose: "attachment",
          operationId: null,
          workspaceId: workspace.id,
          principalId: fixture.principal.id,
          reservedBytes: 60,
          reservedFiles: 6,
          expiresAt: new Date(Date.now() + 150),
        },
        () => limits,
        () => {},
      ),
    ).rejects.toThrow("expired");
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance).toEqual({ bytes: 0, files: 0 });
  } finally {
    await fixture.dispose();
  }
});
