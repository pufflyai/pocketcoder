import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inputFixture as fixture } from "./input-fixture.test";
import { inputBacking } from "./input-storage";

test("controller bytes and ordered pinned manifests survive tampering with workspace copies", async () => {
  const f = await fixture();
  try {
    const a = await f.upload();
    const b = await f.upload("second");
    const id = randomUUID();
    const pinned = await f.service.freeze(id, f.workspace.id, "incarnation-1", [
      b.reference.fileId,
      a.reference.fileId,
    ]);
    expect(pinned.manifest.objects.map((o) => o.fileId)).toEqual([b.reference.fileId, a.reference.fileId]);
    expect(JSON.stringify(pinned)).not.toContain(f.root);
    await writeFile(join(f.root, "workload-sidecar.json"), JSON.stringify({ name: "forged" }));
    expect(
      await f.service.freeze(id, f.workspace.id, "incarnation-1", [b.reference.fileId, a.reference.fileId]),
    ).toEqual(pinned);
    await expect(f.service.freeze(id, f.workspace.id, "incarnation-1", [a.reference.fileId])).rejects.toThrow("frozen");
    await f.service.reconcile(new Date(Date.now() + 700_000));
    expect((await f.store.inputs.get(f.workspace.id, a.reference.fileId))?.state).toBe("ready");
    await f.service.finalize(id);
    await f.service.reconcile(new Date(Date.now() + 700_000));
    expect((await f.store.inputs.get(f.workspace.id, a.reference.fileId))?.state).toBe("expired");
    expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace.bytes).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("same descriptor retry does not read the body; changed metadata conflicts", async () => {
  const f = await fixture();
  try {
    const first = await f.upload();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads++;
        },
      },
      { highWaterMark: 0 },
    );
    expect(
      (
        await f.service.upload(
          f.principal.id,
          first.reference,
          f.workspace.deadlineAt,
          body,
          new AbortController().signal,
        )
      ).created,
    ).toBe(false);
    expect(reads).toBe(0);
    await expect(f.upload("original", { ...first.reference, name: "changed" })).rejects.toThrow("different descriptor");
  } finally {
    await f.dispose();
  }
});

test("one ID has one transfer owner and capacity is charged before body reads", async () => {
  const f = await fixture();
  try {
    const ref = f.reference();
    const claim = {
      reference: ref,
      principalId: f.principal.id,
      reservationId: randomUUID(),
      transferExpiresAt: new Date(Date.now() + 1000),
      retentionMs: f.limits.retentionMs,
      retainedUntil: new Date(Date.now() + 600_000),
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        f.store.inputs.begin({ ...claim, reservationId: randomUUID() }, f.limits, f.options.capacity),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = (await f.store.inputs.get(f.workspace.id, ref.fileId))!;
    expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace).toEqual({
      bytes: 8,
      files: 1,
    });
    await f.store.inputs.begin(
      { ...claim, reference: f.reference(), reservationId: randomUUID() },
      f.limits,
      f.options.capacity,
    );
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads++;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      f.service.upload(f.principal.id, f.reference(), f.workspace.deadlineAt, body, new AbortController().signal),
    ).rejects.toThrow("capacity");
    expect(reads).toBe(0);
    await f.service.reconcile(new Date(row.transferExpiresAt.getTime() + 2));
    expect((await f.store.inputs.get(f.workspace.id, ref.fileId))?.state).toBe("expired");
  } finally {
    await f.dispose();
  }
});

test("size/digest errors and interrupted streams release reservations after removal", async () => {
  const f = await fixture();
  try {
    await expect(f.upload("mutation", f.reference())).rejects.toThrow("digest");
    await expect(f.upload("short", f.reference())).rejects.toThrow("size");
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          abort.abort();
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      f.service.upload(f.principal.id, f.reference(), f.workspace.deadlineAt, body, abort.signal),
    ).rejects.toThrow("ended");
    expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace.bytes).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("missing or same-size corrupt canonical bytes prevent dispatch and cannot be replaced", async () => {
  const f = await fixture();
  try {
    const { reference } = await f.upload();
    const row = (await f.store.inputs.get(f.workspace.id, reference.fileId))!;
    const path = join(f.root, f.workspace.id, reference.fileId, row.reservationId, "payload");
    expect(await readFile(path, "utf8")).toBe("original");
    await writeFile(path, "mutated!");
    await expect(f.service.freeze(randomUUID(), f.workspace.id, "runtime", [reference.fileId])).rejects.toThrow(
      "unavailable",
    );
    expect((await f.store.inputs.get(f.workspace.id, reference.fileId))?.reference.visibility).toBe("unavailable");
    await expect(f.upload("original", reference)).rejects.toThrow("unavailable");
    await f.driver.remove(inputBacking(row));
    await expect(f.service.freeze(randomUUID(), f.workspace.id, "runtime", [reference.fileId])).rejects.toThrow(
      "unavailable",
    );
  } finally {
    await f.dispose();
  }
});

for (const count of [1, 5, 20])
  test(`bounded staging with ${count} concurrent attempts`, async () => {
    const f = await fixture();
    try {
      const started = performance.now();
      const results = await Promise.allSettled(Array.from({ length: count }, () => f.upload()));
      const successful = results.filter((r) => r.status === "fulfilled");
      expect(successful.length).toBeGreaterThan(0);
      expect(successful.length).toBeLessThanOrEqual(Math.min(count, f.limits.transfers));
      console.info(
        JSON.stringify({
          attempts: count,
          transferSlots: f.limits.transfers,
          accepted: successful.length,
          rejected: count - successful.length,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      const rows = await f.store.inputs.list();
      expect(rows.filter((r) => r.state === "uploading")).toHaveLength(0);
      expect((await f.store.storageReservations.usage(f.workspace.id, f.principal.id)).workspace.files).toBe(
        successful.length,
      );
    } finally {
      await f.dispose();
    }
  });
