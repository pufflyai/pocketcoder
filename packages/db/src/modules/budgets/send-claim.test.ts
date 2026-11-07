import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindCompute, managedFixture, provision } from "../managed/fixture.test";

test("one send claim survives retries and only a never-claimed invocation can be abandoned", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const identity = {
      principalId: f.principal.id,
      sessionId: f.sessionId,
      requestId: randomUUID(),
      invocationId: randomUUID(),
    };
    const input = {
      identity,
      workspaceId,
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      model: "fixture/model",
      inputTokens: 20,
      requestedOutputTokens: 20,
    };
    await f.store.managed.budgets.reserve(input);
    expect((await f.store.managed.budgets.reserve(input)).replayed).toBe(true);
    const claims = await Promise.all([
      f.store.managed.budgets.claimSend(identity),
      f.store.managed.budgets.claimSend(identity),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(f.store.managed.budgets.abandonUnsent(identity)).rejects.toThrow();
    await f.store.managed.budgets.retainUncertain(identity);
    expect(await f.store.managed.budgets.claimSend(identity)).toBe(false);
    const other = { ...identity, invocationId: randomUUID() };
    await f.store.managed.budgets.reserve({ ...input, identity: other });
    await f.store.managed.budgets.abandonUnsent(other);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).heldInputTokens).toBe(20);
  } finally {
    await f.dispose();
  }
});

test("close after reservation fences an upstream claim and late uncertainty cannot revive unsent work", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const identity = {
      principalId: f.principal.id,
      sessionId: f.sessionId,
      requestId: randomUUID(),
      invocationId: randomUUID(),
    };
    await f.store.managed.budgets.reserve({
      identity,
      workspaceId,
      model: "fixture/model",
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      inputTokens: 20,
      requestedOutputTokens: 20,
    });
    const current = await f.store.managed.sessions.get(f.keyId, f.sessionId);
    await f.store.managed.sessions.appendObservation(identity, current.revision, "closed", null);
    await expect(f.store.managed.budgets.claimSend(identity)).rejects.toThrow();
    await f.store.managed.budgets.abandonUnsent(identity);
    await f.store.managed.budgets.retainUncertain(identity);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).heldInputTokens).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("physical termination and lease fencing prevent a reserved model call from starting", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const identity = {
      principalId: f.principal.id,
      sessionId: f.sessionId,
      requestId: randomUUID(),
      invocationId: randomUUID(),
    };
    await f.store.managed.budgets.reserve({
      identity,
      workspaceId,
      model: "fixture/model",
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "count/1",
      inputTokens: 1,
      requestedOutputTokens: 1,
    });
    await f.store.transition(workspaceId, { from: ["ready"], to: "terminating", at: new Date() });
    await expect(f.store.managed.budgets.claimSend(identity)).rejects.toThrow();
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).heldInputTokens).toBe(1);
  } finally {
    await f.dispose();
  }
});
