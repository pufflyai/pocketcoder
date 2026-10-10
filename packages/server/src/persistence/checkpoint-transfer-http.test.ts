import { expect, test } from "bun:test";
import { statfsSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

test("one-byte file HTTP upload reserves both native index files and settles real archive allocation", async () => {
  const f = await checkpointHttpFixture(Buffer.from("x"));
  try {
    const preserving = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const grant = await f.grant;
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    if (!transfer?.reservationId) throw new Error("transfer reservation missing");
    const reservation = await f.store.storageReservations.get(transfer.reservationId);
    if (!reservation) throw new Error("reservation missing");
    const block = statfsSync(f.directory).bsize;
    expect(reservation.reservedBytes).toBe(3 * Math.ceil(f.raw.length / block) * block + block);
    const response = await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw });
    expect(response.status).toBe(201);
    await preserving;
    const publication = await f.store.checkpointTransfers.get(grant.transfer_id);
    if (!publication) throw new Error("publication missing");
    expect((await f.store.storageReservations.get(transfer.reservationId))?.reservedBytes).toBe(
      statSync(`${f.directory}/${publication.stagePath}`).blocks * 512,
    );
    expect(publication.storedBytes).toBe(f.raw.length);
  } finally {
    await f.dispose();
  }
});

test("real HTTP upload publishes verified exact bytes before preserve returns", async () => {
  const f = await checkpointHttpFixture();
  try {
    const preserve = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const grant = await f.grant;
    expect((await f.store.getCheckpoint(f.checkpoint.id))?.state).toBe("creating");
    const response = await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw });
    expect(response.status).toBe(201);
    const checkpoint = await preserve;
    expect(checkpoint.state).toBe("ready");
    expect(checkpoint.manifest).toBeNull();
    const name = checkpoint.providerRef?.archivePath;
    if (typeof name !== "string") throw new Error("archive path missing");
    expect(await readFile(join(f.directory, name))).toEqual(f.raw);
    expect(await readdir(f.directory)).toEqual([name]);
    expect((await f.store.checkpointTransfers.get(grant.transfer_id))?.state).toBe("complete");
    await writeFile(join(f.directory, "unknown.tar"), "operator evidence");
    expect(await f.service.inventory()).toMatchObject({
      backend: "controller-archive",
      checkpoint_count: 1,
      unknown_storage: [],
      unknown_checkpoints: ["unknown.tar"],
    });
    expect(await readFile(join(f.directory, "unknown.tar"), "utf8")).toBe("operator evidence");
  } finally {
    await f.dispose();
  }
});

test("truncated real HTTP upload cannot publish and drains normal owned storage", async () => {
  const f = await checkpointHttpFixture();
  try {
    const preserve = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const rejected = preserve.then(
      () => {
        throw new Error("unexpected preserve success");
      },
      (error) => error,
    );
    const grant = await f.grant;
    const response = await fetch(grant.url, {
      method: "PUT",
      headers: f.headers(grant),
      body: f.raw.subarray(0, f.raw.length - 512),
    });
    expect(response.status).toBe(409);
    expect(await rejected).toBeInstanceOf(Error);
    expect((await f.store.getCheckpoint(f.checkpoint.id))?.state).toBe("creating");
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    expect(transfer?.state).toBe("aborted");
    expect((await f.store.storageReservations.get(transfer?.reservationId ?? ""))?.state).toBe("released");
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("replacement Hub object with the same epoch refuses an old HTTP grant", async () => {
  const f = await checkpointHttpFixture();
  let replacement: Awaited<ReturnType<typeof f.connect>> | undefined;
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId).catch((error) => error);
    const grant = await f.grant;
    const originalHeaders = f.headers(grant);
    replacement = await f.connect(f.workspace.id, 3);
    const response = await fetch(grant.url, { method: "PUT", headers: originalHeaders, body: f.raw });
    expect(response.status).toBe(401);
    expect((await f.store.checkpointTransfers.get(grant.transfer_id))?.state).toBe("granted");
    await f.service.cleanup(f.workspace.id);
    expect(await pending).toBeInstanceOf(Error);
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    replacement?.socket.close();
    await f.dispose();
  }
});

test("a normal interrupted HTTP upload drains before releasing physical storage", async () => {
  const f = await checkpointHttpFixture();
  const abort = new AbortController();
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId).catch((error) => error);
    const grant = await f.grant;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(f.raw.subarray(0, 1024));
      },
    });
    const sending = fetch(grant.url, { method: "PUT", headers: f.headers(grant), body, signal: abort.signal }).catch(
      (error) => error,
    );
    const deadline = Date.now() + 1000;
    while ((await f.store.checkpointTransfers.get(grant.transfer_id))?.state !== "streaming" && Date.now() < deadline)
      await Bun.sleep(5);
    expect((await f.store.checkpointTransfers.get(grant.transfer_id))?.state).toBe("streaming");
    abort.abort(new Error("client disconnected"));
    await sending;
    expect(await pending).toBeInstanceOf(Error);
    const transfer = await f.store.checkpointTransfers.get(grant.transfer_id);
    expect(transfer?.state).toBe("aborted");
    expect((await f.store.storageReservations.get(transfer?.reservationId ?? ""))?.state).toBe("released");
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    abort.abort();
    await f.dispose();
  }
});

test("normal close interrupts archive preparation and drains before the store closes", async () => {
  const f = await checkpointHttpFixture();
  try {
    let preparing!: () => void;
    const prepared = new Promise<void>((resolve) => {
      preparing = resolve;
    });
    f.socket.onmessage = (event) => {
      if (JSON.parse(String(event.data)).type === "prepare_checkpoint_archive") preparing();
    };
    let rejected = false;
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId).catch((error) => {
      rejected = true;
      return error;
    });
    await prepared;
    await f.service.close();
    expect(rejected).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect((await f.store.getCheckpoint(f.checkpoint.id))?.state).toBe("creating");
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("HTTP upload refuses an expired DB owner deadline before consuming the grant", async () => {
  const f = await checkpointHttpFixture();
  try {
    const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId).catch((error) => error);
    const grant = await f.grant;
    await f.query(`UPDATE "${f.schema}"."workspaces" SET deadline_at = $1 WHERE id = $2`, [
      new Date(0),
      f.workspace.id,
    ]);
    expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(401);
    expect((await f.store.checkpointTransfers.get(grant.transfer_id))?.state).toBe("granted");
    await f.service.cleanup(f.workspace.id);
    expect(await pending).toBeInstanceOf(Error);
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.dispose();
  }
});
