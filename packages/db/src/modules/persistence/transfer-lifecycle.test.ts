import { expect, test } from "bun:test";
import { checkpointTransferFixture } from "./transfer-fixture.test";

async function streaming() {
  const f = await checkpointTransferFixture();
  const t = f.store.checkpointTransfers;
  await t.grantUpload(
    f.input,
    () => f.capacity,
    () => {},
  );
  await t.claim({ ...f.input, direction: "upload" }, () => {});
  const receipt = {
    summary: {
      mounts: f.input.header.mounts,
      manifest_digest: `sha256:${"c".repeat(64)}`,
      content_digest: `sha256:${"d".repeat(64)}`,
    },
    archiveDigest: `sha256:${"b".repeat(64)}`,
    storedBytes: f.input.expectedArchiveBytes,
    stagePath: `${f.checkpoint.id}-${f.input.id}.tar`,
    stageIdentity: {
      device: "1",
      inode: "2",
      uid: 501,
      gid: 20,
      mode: 384,
      size: "3072",
      allocatedBytes: "4096",
      mtimeNs: "1",
      ctimeNs: "2",
    },
  };
  await t.stage(f.input.id, { stagePath: receipt.stagePath, stageIdentity: receipt.stageIdentity }, () => {});
  return { ...f, t, receipt };
}

test("publication atomically makes bounded checkpoint metadata ready and settles exact physical storage", async () => {
  const f = await streaming();
  try {
    const row = await f.t.publish(f.input.id, f.receipt, () => {}, f.input.retentionLimits);
    expect(row.state).toBe("complete");
    expect(row.grantDigest).toBeNull();
    const checkpoint = await f.store.getCheckpoint(f.checkpoint.id);
    expect(checkpoint?.state).toBe("ready");
    expect(checkpoint?.manifest).toBeNull();
    expect(checkpoint?.providerRef).toEqual({ archivePath: f.receipt.stagePath, transferId: f.input.id });
    const reservation = await f.store.storageReservations.get(f.input.reservationId);
    expect(reservation?.state).toBe("committed");
    expect(reservation?.reservedBytes).toBe(Number(f.receipt.stageIdentity.allocatedBytes));
    expect(reservation?.materializedBytes).toBe(Number(f.receipt.stageIdentity.allocatedBytes));
    expect(reservation?.reservedFiles).toBe(1);
  } finally {
    await f.dispose();
  }
});

test.each(["size", "mounts", "custody", "inode"])(
  "publication refuses changed %s without success or released quota",
  async (change) => {
    const f = await streaming();
    try {
      if (change === "size") f.receipt.storedBytes++;
      if (change === "inode") f.receipt.stageIdentity = { ...f.receipt.stageIdentity, inode: "3" };
      if (change === "mounts") f.receipt.summary.mounts = [{ name: "worktree", logical_bytes: 1, file_count: 1 }];
      const check = () => {
        if (change === "custody") throw new Error("owned publication changed");
      };
      await expect(f.t.publish(f.input.id, f.receipt, check, f.input.retentionLimits)).rejects.toThrow();
      expect((await f.t.get(f.input.id))?.state).toBe("publishing");
      expect((await f.store.getCheckpoint(f.checkpoint.id))?.state).toBe("creating");
      expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("reserved");
    } finally {
      await f.dispose();
    }
  },
);

test("interrupted transfer cleanup revokes grant and releases storage only after owned bytes are removed", async () => {
  const f = await streaming();
  try {
    await expect(
      f.t.abort(f.input.id, () => {
        throw new Error("stage still owned");
      }),
    ).rejects.toThrow();
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("reserved");
    await f.t.abort(f.input.id, () => {});
    expect((await f.t.get(f.input.id))?.state).toBe("aborted");
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("released");
  } finally {
    await f.dispose();
  }
});
