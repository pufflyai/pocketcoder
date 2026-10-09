import { expect, test } from "bun:test";
import { checkpointTransferFixture } from "./transfer-fixture.test";

async function policy() {
  const f = await checkpointTransferFixture();
  const now = new Date();
  await f.query(
    `UPDATE "${f.schema}"."workspaces" SET deadline_at=$1, reason_code='preserved_by_policy', template_snapshot=jsonb_set(template_snapshot, '{spec,persistence,checkpoint,onDeadline}', '"preserve"') WHERE id=$2`,
    [new Date(now.getTime() - 1000), f.workspace.id],
  );
  await f.query(
    `UPDATE "${f.schema}"."workspace_operations" SET reason_code='preserved_by_policy', idempotency_key=$1, created_at=$2 WHERE id=$3`,
    [`policy:deadline:${f.workspace.id}`, now, f.input.operationId],
  );
  return f;
}

test("only a server-admitted deadline policy operation can upload after workload expiry", async () => {
  const f = await policy();
  try {
    const transfer = await f.store.checkpointTransfers.grantUpload(
      f.input,
      () => f.capacity,
      () => {},
    );
    expect(transfer.state).toBe("granted");
    await f.store.checkpointTransfers.claim({ ...f.input, direction: "upload" }, () => {});
    expect((await f.store.checkpointTransfers.get(transfer.id))?.state).toBe("streaming");
    await f.store.checkpointTransfers.abort(transfer.id, () => {});
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("released");
  } finally {
    await f.dispose();
  }
});

test("native sub-millisecond grant expiry cannot exceed the policy cap after admission", async () => {
  const f = await policy();
  try {
    const origin = new Date(Date.now() - 30_000);
    f.input.expiresAt = new Date(origin.getTime() + 60_000);
    await f.query(`UPDATE "${f.schema}"."workspaces" SET deadline_at=$1 WHERE id=$2`, [
      new Date(origin.getTime() - 1000),
      f.workspace.id,
    ]);
    await f.query(`UPDATE "${f.schema}"."workspace_operations" SET created_at=$1 WHERE id=$2`, [
      origin,
      f.input.operationId,
    ]);
    await f.store.checkpointTransfers.grantUpload(
      f.input,
      () => f.capacity,
      () => {},
    );
    await f.query(
      `UPDATE "${f.schema}"."checkpoint_transfers" SET expires_at=expires_at+interval '1 microsecond' WHERE id=$1`,
      [f.input.id],
    );
    await f.query(
      `UPDATE "${f.schema}"."storage_reservations" SET expires_at=expires_at+interval '1 microsecond' WHERE id=$1`,
      [f.input.reservationId],
    );
    await expect(f.store.checkpointTransfers.claim({ ...f.input, direction: "upload" }, () => {})).rejects.toThrow(
      "deadline",
    );
    expect((await f.store.checkpointTransfers.get(f.input.id))?.state).toBe("granted");
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("reserved");
    await f.store.checkpointTransfers.abort(f.input.id, () => {});
    expect((await f.store.storageReservations.get(f.input.reservationId))?.state).toBe("released");
  } finally {
    await f.dispose();
  }
});

test.each([
  "admission",
  "key",
  "policy",
  "expired-window",
  "infinite-origin",
  "infinite-workload",
  "future-origin",
  "native-bound",
] as const)("deadline policy refuses invalid %s authority without a reservation", async (change) => {
  const f = await policy();
  try {
    if (change === "admission")
      await f.query(`UPDATE "${f.schema}"."workspace_operations" SET reason_code=NULL WHERE id=$1`, [
        f.input.operationId,
      ]);
    if (change === "key")
      await f.query(`UPDATE "${f.schema}"."workspace_operations" SET idempotency_key='ordinary-preserve' WHERE id=$1`, [
        f.input.operationId,
      ]);
    if (change === "policy")
      await f.query(
        `UPDATE "${f.schema}"."workspaces" SET template_snapshot=jsonb_set(template_snapshot, '{spec,persistence,checkpoint,onDeadline}', '"terminate"') WHERE id=$1`,
        [f.workspace.id],
      );
    if (change === "expired-window")
      await f.query(`UPDATE "${f.schema}"."workspace_operations" SET created_at=$1 WHERE id=$2`, [
        new Date(Date.now() - 61_000),
        f.input.operationId,
      ]);
    if (change === "infinite-origin")
      await f.query(`UPDATE "${f.schema}"."workspace_operations" SET created_at='infinity' WHERE id=$1`, [
        f.input.operationId,
      ]);
    if (change === "infinite-workload")
      await f.query(`UPDATE "${f.schema}"."workspaces" SET deadline_at='-infinity' WHERE id=$1`, [f.workspace.id]);
    if (change === "future-origin")
      await f.query(`UPDATE "${f.schema}"."workspace_operations" SET created_at=$1 WHERE id=$2`, [
        new Date(Date.now() + 1000),
        f.input.operationId,
      ]);
    if (change === "native-bound") {
      await f.query(`UPDATE "${f.schema}"."workspaces" SET deadline_at=$1 WHERE id=$2`, [
        new Date(Date.now() - 31_000),
        f.workspace.id,
      ]);
      await f.query(
        `UPDATE "${f.schema}"."workspace_operations" SET created_at=$1::timestamptz - interval '60 seconds' - interval '1 microsecond' WHERE id=$2`,
        [f.input.expiresAt.toISOString(), f.input.operationId],
      );
    }
    await expect(
      f.store.checkpointTransfers.grantUpload(
        f.input,
        () => f.capacity,
        () => {},
      ),
    ).rejects.toThrow();
    expect(await f.store.checkpointTransfers.get(f.input.id)).toBeNull();
    expect(await f.store.storageReservations.get(f.input.reservationId)).toBeNull();
  } finally {
    await f.dispose();
  }
});
