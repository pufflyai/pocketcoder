import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inputFixture } from "./input-fixture.test";
import { inputBacking } from "./input-storage";

test("aggregate bytes and file count include committed inputs; exhaustion never evicts them", async () => {
  const f = await inputFixture();
  try {
    f.limits.stagedBytes = 8;
    const { reference } = await f.upload();
    await expect(f.upload("x")).rejects.toThrow("capacity");
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.state).toBe("ready");
    f.limits.stagedBytes = 16;
    f.limits.files = 1;
    await expect(f.upload("x")).rejects.toThrow("capacity");
    const row = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    expect(await new Response(await f.driver.read(inputBacking(row), reference)).text()).toBe("original");
  } finally {
    await f.dispose();
  }
});

test("failed attempts may retry their ID after cleanup; ready or expired accepted objects never change", async () => {
  const f = await inputFixture();
  try {
    const reference = f.reference();
    await expect(f.upload("bad", reference)).rejects.toThrow("size");
    expect((await f.upload("original", reference)).created).toBe(true);
    await f.service.reconcile(new Date(Date.now() + 700_000));
    await expect(f.upload("original", reference)).rejects.toThrow("unavailable");
  } finally {
    await f.dispose();
  }
});

test("cleanup failure keeps storage charged until physical removal succeeds", async () => {
  const f = await inputFixture();
  const parked = `${f.root}-parked`;
  try {
    const { reference } = await f.upload();
    const row = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    await rename(f.root, parked);
    await writeFile(f.root, "storage unavailable");
    await expect(f.service.reconcile(new Date(Date.now() + 700_000))).rejects.toThrow();
    expect((await f.store.storageReservations.get(row.reservationId))?.state).toBe("releasing");
    expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace.bytes).toBe(8);
    await rm(f.root);
    await rename(parked, f.root);
    await f.service.reconcile();
    expect((await f.store.storageReservations.get(row.reservationId))?.state).toBe("released");
  } finally {
    await rm(parked, { recursive: true, force: true });
    await f.dispose();
  }
});

test("symlink substitution of canonical payload is unavailable evidence", async () => {
  const f = await inputFixture();
  try {
    const { reference } = await f.upload();
    const row = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    const payload = join(f.root, f.workspace.id, reference.fileId, row.reservationId, "payload");
    await rename(payload, `${payload}-original`);
    await symlink(`${payload}-original`, payload);
    await expect(f.service.freeze(randomUUID(), f.workspace.id, "runtime", [reference.fileId])).rejects.toThrow(
      "unavailable",
    );
  } finally {
    await f.dispose();
  }
});

test("idle body deadline releases its transfer and selected bytes rebuild a lost projection", async () => {
  const f = await inputFixture();
  try {
    f.limits.transferMs = 20;
    const idle = new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 });
    await expect(
      f.service.upload(f.principal.id, f.reference(), f.workspace.deadlineAt, idle, new AbortController().signal),
    ).rejects.toThrow("ended");
    expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace.bytes).toBe(0);
    f.limits.transferMs = 1000;
    const { reference } = await f.upload();
    const frozen = await f.service.freeze(randomUUID(), f.workspace.id, "incarnation", [reference.fileId]);
    const projection = join(f.root, "fixture-workload-copy.txt");
    const selected = frozen.objects[0]!;
    const rebuild = async () =>
      writeFile(projection, await new Response(await f.driver.read(selected.backing, selected.reference)).text());
    await rebuild();
    await writeFile(projection, "mutated!");
    await rm(projection);
    await rebuild();
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(projection, "utf8")).toBe("original");
    expect(frozen.manifest.objects).toEqual([reference]);
  } finally {
    await f.dispose();
  }
});
