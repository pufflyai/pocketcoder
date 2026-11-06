import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindCompute, managedFixture, provision } from "../managed/fixture.test";

test("an unclaimed reservation cannot become uncertain or accept provider usage", async () => {
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
      countEvidenceRef: "local-count/unsent",
      inputTokens: 20,
      requestedOutputTokens: 20,
    });
    await expect(f.store.managed.budgets.retainUncertain(identity)).rejects.toMatchObject({ code: "budget.conflict" });
    await expect(
      f.store.managed.budgets.settle({
        identity,
        provider: "local",
        providerAccountId: "fixture",
        responseId: "never-sent",
        inputTokens: 10,
        outputTokens: 10,
        providerEvidenceRef: "fixture/unsent",
        observedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "budget.conflict" });
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      heldInputTokens: 20,
      heldOutputTokens: 20,
      inFlightModelRequests: 1,
      unresolvedInvocations: 0,
    });
    await f.store.managed.budgets.abandonUnsent(identity);
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      heldInputTokens: 0,
      heldOutputTokens: 0,
      inFlightModelRequests: 0,
    });
  } finally {
    await f.dispose();
  }
});

test("trusted settlement is idempotent and conflicting evidence fences retained exposure", async () => {
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
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "local-count/1",
      model: "fixture/model",
      workspaceId,
      inputTokens: 30,
      requestedOutputTokens: 20,
    });
    await f.store.managed.budgets.claimSend(identity);
    const evidence = {
      provider: "local",
      providerAccountId: "fixture",
      responseId: "response-1",
      identity,
      inputTokens: 25,
      outputTokens: 12,
      providerEvidenceRef: "local-provider/1",
      observedAt: new Date(),
    };
    await f.store.managed.budgets.settle(evidence);
    await f.store.managed.budgets.settle(evidence);
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      settledInputTokens: 25,
      settledOutputTokens: 12,
      heldInputTokens: 0,
      inFlightModelRequests: 0,
    });
    await f.store.managed.budgets.settle({
      ...evidence,
      outputTokens: 19,
      providerEvidenceRef: "local-provider/conflict",
    });
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      settledOutputTokens: 19,
      blockedReason: "conflicting_usage",
    });
    await expect(
      f.store.managed.budgets.reserve({
        identity: { ...identity, invocationId: randomUUID() },
        requestDigest: `sha256:${"a".repeat(64)}`,
        countEvidenceRef: "local-count/1",
        model: "fixture/model",
        workspaceId,
        inputTokens: 1,
        requestedOutputTokens: 1,
      }),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

test("audited reconciliation supersedes duplicate conflicting reports without reopening a fence", async () => {
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
      inputTokens: 30,
      requestedOutputTokens: 20,
    });
    await f.store.managed.budgets.claimSend(identity);
    const a = {
      identity,
      inputTokens: 25,
      outputTokens: 12,
      provider: "local",
      providerAccountId: "fixture",
      responseId: randomUUID(),
      providerEvidenceRef: "fixture/terminal-a",
      observedAt: new Date(),
    };
    const b = { ...a, outputTokens: 19, providerEvidenceRef: "fixture/terminal-b" };
    await f.store.managed.budgets.settle(a);
    await f.store.managed.budgets.settle(b);
    await f.store.managed.budgets.reconcile(f.keyId, a, "Provider confirmed original response totals");
    await f.store.managed.budgets.settle(b);
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      blockedReason: null,
      settledOutputTokens: 12,
      heldOutputTokens: 0,
    });
    expect(await f.context.db.select().from(f.context.tables.budgetAudits)).toHaveLength(1);
    expect(await f.context.db.select().from(f.context.tables.budgetReports)).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});
