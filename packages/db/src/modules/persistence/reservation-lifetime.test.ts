import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, statfsSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";
import { createStorageReservations } from "./reservations";

test("a native infinite workspace deadline cannot admit physical storage", async () => {
  const fixture = await createPGliteFixture("storage-infinite-deadline", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "infinite");
    await fixture.query("UPDATE pocketcoder.workspaces SET deadline_at = 'infinity' WHERE id = $1", [workspace.id]);
    const reservations = createStorageReservations(fixture.context);
    const input = {
      id: randomUUID(),
      purpose: "attachment" as const,
      operationId: null,
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      reservedBytes: 1,
      reservedFiles: 1,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const amount = { bytes: 100, files: 10 };
    const capacity = {
      workspace: amount,
      principal: amount,
      instance: amount,
      freeDisk: { bytes: 200, files: 20, headroomBytes: 100, headroomFiles: 10 },
    };
    await expect(
      reservations.reserve(
        input,
        () => capacity,
        () => {},
      ),
    ).rejects.toThrow("deadline");
    expect(await reservations.get(input.id)).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

test("admission samples native free space after a queued materialization commits", async () => {
  const fixture = await createPGliteFixture("storage-fresh-capacity", "disk");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const workspace = await insertTestWorkspace(fixture, "physical");
    const reservations = createStorageReservations(fixture.context);
    const free = () => {
      const stats = statfsSync(fixture.context.dataDir!);
      return { bytes: stats.bavail * stats.bsize, files: stats.ffree, headroomBytes: 0, headroomFiles: 0 };
    };
    const scopes = {
      workspace: { bytes: 1_000_000, files: 100 },
      principal: { bytes: 1_000_000, files: 100 },
      instance: { bytes: 1_000_000, files: 100 },
    };
    const input = {
      id: randomUUID(),
      purpose: "attachment" as const,
      operationId: null,
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      reservedBytes: 131072,
      reservedFiles: 1,
      expiresAt: new Date(Date.now() + 30_000),
    };
    await reservations.reserve(
      input,
      () => ({ ...scopes, freeDisk: free() }),
      () => {},
    );
    const unrelatedPath = join(fixture.context.dataDir!, "unrelated");
    const unrelated = openSync(unrelatedPath, "wx", 0o600);
    try {
      writeSync(unrelated, Buffer.alloc(1_048_576, 7));
      fsyncSync(unrelated);
    } finally {
      closeSync(unrelated);
    }
    const materializedPath = join(fixture.context.dataDir!, "materialized");
    const holder = fixture.context.db.transaction(async (tx) => {
      entered.resolve();
      await release.promise;
      const descriptor = openSync(materializedPath, "wx", 0o600);
      try {
        writeSync(descriptor, Buffer.alloc(131072, 1));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      unlinkSync(unrelatedPath);
      const table = fixture.context.tables.storageReservations;
      await tx.update(table).set({ materializedBytes: 131072, materializedFiles: 1 }).where(eq(table.id, input.id));
    });
    await entered.promise;
    let sampled = false;
    const pending = reservations
      .reserve(
        { ...input, id: randomUUID(), reservedBytes: 65536 },
        () => {
          sampled = true;
          const current = free();
          const materialized = statSync(materializedPath);
          const allocatedBytes = materialized.blocks * 512;
          expect(materialized.size).toBe(input.reservedBytes);
          expect(allocatedBytes).toBe(input.reservedBytes);
          // Keep the native sample, but define this fixture's headroom from its
          // own allocation. Unrelated frees cannot erase its materialization.
          const headroomBytes = current.bytes - input.reservedBytes + allocatedBytes;
          return { ...scopes, freeDisk: { ...current, headroomBytes } };
        },
        () => {},
      )
      .then(
        () => "accepted",
        (error: Error) => error.message,
      );
    await Bun.sleep(10);
    expect(sampled).toBe(false);
    release.resolve();
    await holder;
    expect(await pending).toContain("headroom");
    expect(sampled).toBe(true);
    expect((await reservations.get(input.id))?.materializedBytes).toBe(input.reservedBytes);
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance.bytes).toBe(131072);
  } finally {
    release.resolve();
    await fixture.dispose();
  }
});

test("expired reservations can account for partial files but cannot commit them", async () => {
  const fixture = await createPGliteFixture("storage-commit-expiry", "disk");
  try {
    const workspace = await insertTestWorkspace(fixture, "expired");
    const reservations = createStorageReservations(fixture.context);
    const input = {
      id: randomUUID(),
      purpose: "attachment" as const,
      operationId: null,
      workspaceId: workspace.id,
      principalId: fixture.principal.id,
      reservedBytes: 65536,
      reservedFiles: 1,
      expiresAt: new Date(Date.now() + 200),
    };
    const capacity = {
      workspace: { bytes: 100_000, files: 10 },
      principal: { bytes: 100_000, files: 10 },
      instance: { bytes: 100_000, files: 10 },
      freeDisk: { bytes: 200_000, files: 20, headroomBytes: 100_000, headroomFiles: 10 },
    };
    await reservations.reserve(
      input,
      () => capacity,
      () => {},
    );
    const descriptor = openSync(join(fixture.context.dataDir!, "expired-partial"), "wx", 0o600);
    try {
      writeSync(descriptor, Buffer.alloc(65536, 1));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    await Bun.sleep(250);
    await reservations.materialize(input.id, { bytes: 65536, files: 1 }, () => {});
    await expect(reservations.commit(input.id, () => {})).rejects.toThrow("expired");
    expect((await reservations.get(input.id))?.state).toBe("reserved");
    await reservations.beginRelease(input.id, () => {});
    expect((await reservations.usage(workspace.id, fixture.principal.id)).instance.bytes).toBe(65536);
  } finally {
    await fixture.dispose();
  }
});
