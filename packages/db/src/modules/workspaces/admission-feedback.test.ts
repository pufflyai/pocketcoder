import { expect, test } from "bun:test";
import { DatabaseStore } from "../../store";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

test("queued feedback survives restart, wakes once, and cannot change canceled or purged work", async () => {
  const fixture = await createPGliteFixture("admission-feedback", "disk");
  try {
    const row = await insertTestWorkspace(fixture, "queued");
    const changed = fixture.store.waitForWorkspaceChange(row.id, row.changeSeq, 1000);
    await fixture.store.setQueuedAdmissionReason(row.id, "admission_actor_capacity", new Date());
    await changed;
    const after = await fixture.store.getWorkspace(row.id);
    await fixture.store.setQueuedAdmissionReason(row.id, "admission_actor_capacity", new Date());
    expect(await fixture.store.getWorkspace(row.id)).toEqual(after);
    await fixture.store.close();
    const reopened = await DatabaseStore.openPGlite(fixture.directory);
    try {
      expect(await reopened.getWorkspace(row.id)).toEqual(after);
      await reopened.transition(row.id, {
        from: ["queued"],
        to: "canceled",
        reason: "canceled_by_caller",
        at: new Date(),
      });
      const canceled = await reopened.getWorkspace(row.id);
      await reopened.setQueuedAdmissionReason(row.id, "admission_global_capacity", new Date());
      expect(await reopened.getWorkspace(row.id)).toEqual(canceled);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test("purge fences a queued feedback write", async () => {
  const fixture = await createPGliteFixture("admission-purge");
  try {
    const row = await insertTestWorkspace(fixture, "purged");
    await fixture.store.insertOperation({
      id: crypto.randomUUID(),
      principalId: row.principalId,
      kind: "purge",
      state: "running",
      idempotencyKey: "purge",
      requestDigest: "purge",
      workspaceId: row.id,
      checkpointId: null,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    });
    const purged = await fixture.store.getWorkspace(row.id);
    await fixture.store.setQueuedAdmissionReason(row.id, "admission_denied", new Date());
    expect(await fixture.store.getWorkspace(row.id)).toEqual(purged);
  } finally {
    await fixture.dispose();
  }
});
