import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGliteStore } from "../../store";
import { screenshotFixture } from "./screenshot-fixture";

test("a screenshot commits private bytes under its reservation and purge fences a late capture", async () => {
  const f = await screenshotFixture();
  try {
    const { workspace, input, capacity } = f;
    await f.store.binaryOutputs.begin(input, capacity, () => {});
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    await f.store.binaryOutputs.publish(input.id, png, () => {});
    expect(await f.store.binaryOutputs.content(input.id, f.principal.id)).toEqual(png);
    expect((await f.store.listOutputs(workspace.id))[0]?.value).toMatchObject({
      kind: "screenshot",
      id: input.id,
      content_type: "image/png",
    });
    expect((await f.store.storageReservations.get(input.reservationId))?.state).toBe("committed");
    await expect(
      f.store.binaryOutputs.begin({ ...input, id: randomUUID(), reservationId: randomUUID() }, capacity, () => {}),
    ).rejects.toThrow("capacity");
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(f.context.tables.workspaces.id, workspace.id));
    await f.store.binaryOutputs.purge(workspace.id);
    expect(await f.store.binaryOutputs.content(input.id, f.principal.id)).toBeNull();
    expect((await f.store.storageReservations.get(input.reservationId))?.state).toBe("released");
    await expect(f.store.binaryOutputs.publish(input.id, png, () => {})).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("retained screenshot bytes survive restart then expire and cannot be republished", async () => {
  const f = await screenshotFixture("disk");
  let reopened: PGliteStore | undefined;
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    await f.store.binaryOutputs.begin(f.input, f.capacity, () => {});
    await f.store.binaryOutputs.publish(f.input.id, png, () => {});
    await f.store.close();
    reopened = await PGliteStore.create(f.directory);
    await reopened.init();
    expect(await reopened.binaryOutputs.content(f.input.id, f.principal.id)).toEqual(png);
    await reopened.binaryOutputs.prune(new Date(f.input.retainedUntil.getTime() + 1));
    expect(await reopened.binaryOutputs.content(f.input.id, f.principal.id)).toBeNull();
    expect((await reopened.storageReservations.get(f.input.reservationId))?.state).toBe("released");
    await expect(reopened.binaryOutputs.publish(f.input.id, png, () => {})).rejects.toThrow();
  } finally {
    await reopened?.close();
    await f.dispose();
  }
});

test("a new connection epoch rejects an old capture before bytes can commit", async () => {
  const f = await screenshotFixture();
  try {
    await f.store.binaryOutputs.begin(f.input, f.capacity, () => {});
    await f.store.updateWorkspace(f.workspace.id, { connectionEpoch: 1 }, new Date());
    await expect(f.store.binaryOutputs.publish(f.input.id, new Uint8Array([1]), () => {})).rejects.toThrow("authority");
    expect(await f.store.binaryOutputs.content(f.input.id, f.principal.id)).toBeNull();
    await f.store.binaryOutputs.discard(f.input.id);
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("released");
  } finally {
    await f.dispose();
  }
});
