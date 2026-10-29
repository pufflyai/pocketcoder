import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

async function fixture(content?: Uint8Array) {
  const f = await checkpointHttpFixture(content);
  const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
  const grant = await f.grant;
  expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
  const checkpoint = await pending;
  return { ...f, checkpoint, grant };
}

test("normal checkpoint verify and delete retain exact custody and settle the durable charge", async () => {
  const f = await fixture();
  try {
    await f.service.verify(f.checkpoint);
    await expect(f.service.delete(f.checkpoint)).rejects.toThrow();
    await f.store.updateCheckpoint(f.checkpoint.id, { state: "deleting" }, new Date());
    await f.service.delete(f.checkpoint);
    expect(await readdir(f.directory)).toEqual([]);
    const row = await f.store.checkpointTransfers.get(f.grant.transfer_id);
    expect(row?.state).toBe("aborted");
    expect((await f.store.storageReservations.get(row?.reservationId ?? ""))?.state).toBe("released");
  } finally {
    await f.dispose();
  }
});

test("changed archive bytes refuse verification and never release custody or quota", async () => {
  const f = await fixture();
  try {
    const path = f.checkpoint.providerRef?.archivePath;
    if (typeof path !== "string") throw new Error("checkpoint path missing");
    await writeFile(join(f.directory, path), Buffer.alloc(f.raw.length, 3));
    await expect(f.service.verify(f.checkpoint)).rejects.toThrow();
    await f.store.updateCheckpoint(f.checkpoint.id, { state: "deleting" }, new Date());
    await expect(f.service.delete(f.checkpoint)).rejects.toThrow();
    const row = await f.store.checkpointTransfers.get(f.grant.transfer_id);
    expect((await f.store.storageReservations.get(row?.reservationId ?? ""))?.state).toBe("committed");
    expect(await readdir(f.directory)).toEqual([path]);
  } finally {
    await f.dispose();
  }
});

test("one file reads back from a published archive with the archive's digest checks", async () => {
  const f = await fixture(Buffer.from("diagnostic transcript"));
  try {
    expect((await f.service.readFile(f.checkpoint, "worktree", "tiny", 1024))?.toString()).toBe(
      "diagnostic transcript",
    );
    expect(await f.service.readFile(f.checkpoint, "worktree", "missing", 1024)).toBeNull();
    expect(await f.service.readFile(f.checkpoint, "other-mount", "tiny", 1024)).toBeNull();
    await expect(f.service.readFile(f.checkpoint, "worktree", "tiny", 4)).rejects.toThrow("artifact.too_large");
  } finally {
    await f.dispose();
  }
});
