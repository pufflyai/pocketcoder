import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindCompute, managedFixture, policy, provision } from "../managed/fixture.test";

test("atomic all-scope reservation denies overspend and replays without consuming twice", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const input = {
      identity: {
        principalId: f.principal.id,
        sessionId: f.sessionId,
        requestId: randomUUID(),
        invocationId: randomUUID(),
      },
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      model: "fixture/model",
      workspaceId,
      inputTokens: 60,
      requestedOutputTokens: 30,
    };
    const results = await Promise.allSettled([
      f.store.managed.budgets.reserve(input),
      f.store.managed.budgets.reserve({ ...input, identity: { ...input.identity, invocationId: randomUUID() } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw Error("Missing winner");
    expect(winner.value.reservation.inputTokens).toBe(60);
    const usage = await f.store.managed.budgets.usage(f.keyId, f.scopeId);
    expect(usage.heldInputTokens).toBe(60);
    await f.store.managed.budgets.writePolicy(
      f.keyId,
      { ...policy(f.scopeId, 2), limits: { ...policy(f.scopeId).limits, inputTokens: 0 } },
      1,
    );
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).heldInputTokens).toBe(60);
  } finally {
    await f.dispose();
  }
});
