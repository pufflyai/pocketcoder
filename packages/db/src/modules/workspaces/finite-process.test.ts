import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { FiniteProcessFact } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "../../store";
import { insertTestWorkspace } from "../../test-fixtures";
import { executionFixture } from "./execution-fixture.test";

test("runtime identity and accepted process facts survive reconnect and cannot retarget restore", async () => {
  const f = await executionFixture(undefined, { mode: "disk" });
  try {
    const input = f.acceptance();
    const claimed: FiniteProcessFact = {
      execution: { ...input.execution, owner: "process" },
      fingerprint: input.fingerprint,
      phase: "claimed",
      claimedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      processGroupId: null,
      exitCode: null,
      signal: null,
    };
    expect(await f.store.recordFiniteProcess(f.id, 1, claimed)).toBe(false);
    await f.store.executions.accept(input, new Date());
    expect(await f.store.recordFiniteProcess(f.id, 1, claimed)).toBe(false);
    await f.store.executions.claim(input.execution, new Date());
    expect(await f.store.recordFiniteProcess(f.id, 1, claimed)).toBe(true);
    await f.store.updateWorkspace(f.id, { connectionEpoch: 2 }, new Date());
    const exited: FiniteProcessFact = {
      ...claimed,
      phase: "exited",
      startedAt: claimed.claimedAt,
      endedAt: new Date().toISOString(),
      processGroupId: 123,
      exitCode: 7,
    };
    expect(await f.store.recordFiniteProcess(f.id, 1, exited)).toBe(false);
    expect(await f.store.recordFiniteProcess(f.id, 2, exited)).toBe(true);
    expect(await f.store.recordFiniteProcess(f.id, 2, claimed)).toBe(false);
    expect(await f.store.recordFiniteProcess(f.id, 2, exited)).toBe(true);
    expect(
      await f.store.bindWorkspaceRuntime(
        f.id,
        { ...f.runtime, producer: null, incarnationId: "replacement", containerIdentity: "replacement" },
        { kind: "docker", id: f.runtime.incarnationId },
      ),
    ).toBe(false);
    const restored = await insertTestWorkspace(f, randomUUID());
    expect(await f.store.recordFiniteProcess(restored.id, 2, exited)).toBe(false);
    expect((await f.store.getWorkspace(restored.id))?.finiteProcess).toBeNull();
    await f.store.close();
    const reopened = await DatabaseStore.openPGlite(f.directory);
    try {
      expect((await reopened.getWorkspace(f.id))?.finiteProcess).toEqual(exited);
      expect((await reopened.executions.get(input.execution))?.outcome).toEqual(exited);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test("runtime loss ends accepted uncertain work without inventing an exit code", async () => {
  const f = await executionFixture();
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date());
    await f.store.executions.claim(input.execution, new Date());
    await f.store.recordFiniteProcess(f.id, 1, {
      execution: { ...input.execution, owner: "process" },
      fingerprint: input.fingerprint,
      phase: "claimed",
      claimedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      processGroupId: null,
      exitCode: null,
      signal: null,
    });
    await f.store.endWorkspaceRuntime(f.id, input.execution.incarnationId, new Date());
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toMatchObject({
      phase: "lost",
      exitCode: null,
      signal: null,
    });
    expect((await f.store.executions.get(input.execution))?.phase).toBe("lost");
  } finally {
    await f.dispose();
  }
});

test("controller loss is final even when claimed producer facts arrive later", async () => {
  const f = await executionFixture();
  try {
    const input = f.acceptance();
    await f.store.executions.accept(input, new Date());
    await f.store.executions.claim(input.execution, new Date());
    expect(await f.store.executions.claim(input.execution, new Date(Date.now() + 600_001))).toBeNull();
    const running: FiniteProcessFact = {
      execution: { ...input.execution, owner: "process" },
      fingerprint: input.fingerprint,
      phase: "running",
      claimedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      processGroupId: 123,
      exitCode: null,
      signal: null,
    };
    expect(await f.store.recordFiniteProcess(f.id, 1, running)).toBe(false);
    expect(
      await f.store.recordFiniteProcess(f.id, 1, {
        ...running,
        phase: "exited",
        exitCode: 0,
        endedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect((await f.store.executions.get(input.execution))?.phase).toBe("lost");
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toBeNull();
  } finally {
    await f.dispose();
  }
});
