import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { FiniteProcessFact } from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "../../store";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

// Real durable workspace rows, including reconnect fencing and terminal replay.
test("runtime identity and process facts survive reconnect and cannot retarget restore", async () => {
  const f = await createPGliteFixture("process-facts", "disk");
  try {
    const row = await insertTestWorkspace(f, randomUUID());
    const ref = { kind: "docker", id: "observed-container" };
    await f.store.transition(row.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: "docker", providerRef: ref },
    });
    const runtime = {
      incarnationId: "observed-container",
      containerIdentity: "observed-container",
      profile: "finite-process" as const,
      producer: null,
    };
    expect(await f.store.bindWorkspaceRuntime(row.id, runtime, ref)).toBe(true);
    const execution = {
      workspaceId: row.id,
      incarnationId: runtime.incarnationId,
      owner: "process" as const,
      requestId: randomUUID(),
    };
    const claimed: FiniteProcessFact = {
      execution,
      fingerprint: `sha256:${"a".repeat(64)}`,
      phase: "claimed",
      claimedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      processGroupId: null,
      exitCode: null,
      signal: null,
    };
    await f.store.transition(row.id, {
      from: ["provisioning"],
      to: "connected",
      at: new Date(),
      patch: { connectionEpoch: 1 },
    });
    expect(await f.store.recordFiniteProcess(row.id, 1, claimed)).toBe(true);
    await f.store.updateWorkspace(row.id, { connectionEpoch: 2 }, new Date());
    const exited = {
      ...claimed,
      phase: "exited" as const,
      startedAt: claimed.claimedAt,
      endedAt: new Date().toISOString(),
      processGroupId: 123,
      exitCode: 7,
    };
    expect(await f.store.recordFiniteProcess(row.id, 1, exited)).toBe(false);
    expect(await f.store.recordFiniteProcess(row.id, 2, exited)).toBe(true);
    expect(await f.store.recordFiniteProcess(row.id, 2, claimed)).toBe(false);
    expect(await f.store.recordFiniteProcess(row.id, 2, exited)).toBe(true);
    expect(
      await f.store.bindWorkspaceRuntime(
        row.id,
        { ...runtime, incarnationId: "replacement", containerIdentity: "replacement" },
        ref,
      ),
    ).toBe(false);
    const restored = await insertTestWorkspace(f, randomUUID());
    expect(await f.store.recordFiniteProcess(restored.id, 2, exited)).toBe(false);
    expect((await f.store.getWorkspace(row.id))?.finiteProcess).toEqual(exited);
    expect((await f.store.getWorkspace(restored.id))?.finiteProcess).toBeNull();
    await f.store.close();
    const reopened = await PGliteStore.create(f.directory);
    try {
      expect((await reopened.getWorkspace(row.id))?.finiteProcess).toEqual(exited);
      expect((await reopened.getWorkspace(row.id))?.runtimeRegistration?.incarnationId).toBe(runtime.incarnationId);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test("runtime loss ends uncertain work without inventing an exit code", async () => {
  const f = await createPGliteFixture("lost-process");
  try {
    const row = await insertTestWorkspace(f, randomUUID());
    const ref = { kind: "docker", id: "container" };
    await f.store.transition(row.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: "docker", providerRef: ref },
    });
    await f.store.bindWorkspaceRuntime(
      row.id,
      { incarnationId: "container", containerIdentity: "container", profile: "finite-process", producer: null },
      ref,
    );
    await f.store.transition(row.id, {
      from: ["provisioning"],
      to: "connected",
      at: new Date(),
      patch: { connectionEpoch: 1 },
    });
    await f.store.recordFiniteProcess(row.id, 1, {
      execution: { workspaceId: row.id, incarnationId: "container", owner: "process", requestId: randomUUID() },
      fingerprint: `sha256:${"a".repeat(64)}`,
      phase: "claimed",
      claimedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      processGroupId: null,
      exitCode: null,
      signal: null,
    });
    await f.store.endWorkspaceRuntime(row.id, "container", new Date());
    expect((await f.store.getWorkspace(row.id))?.finiteProcess).toMatchObject({
      phase: "lost",
      exitCode: null,
      signal: null,
    });
  } finally {
    await f.dispose();
  }
});
