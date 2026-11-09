import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { gatewayFixture, textRequest } from "./gateway-fixture.test";
import { until } from "./provider-fixture.test";
import { reconcileGatewayInvocations } from "./reconcile";

test("a stream dropped before usage keeps its full hold as uncertain and is never resent", async () => {
  const g = await gatewayFixture({ inputTokens: 30, outputTokens: 10 });
  try {
    g.provider.setMode("drop-before-usage");
    const reply = await g.call(textRequest({ stream: true }));
    await reply.text().catch(() => "");
    await until(async () => (await g.invocations())[0]?.state === "uncertain");
    expect(g.provider.generations()).toHaveLength(1);
    expect(await g.usage()).toMatchObject({
      heldInputTokens: 30,
      heldOutputTokens: 20,
      unresolvedInvocations: 1,
      settledInputTokens: 0,
    });
    expect((await g.invocations())[0]?.responseId).toMatch(/^resp_/);
    expect(await reconcileGatewayInvocations(g.f.store.managed.budgets)).toEqual({ abandoned: 0, uncertain: 0 });
    expect(g.provider.generations()).toHaveLength(1);
  } finally {
    await g.dispose();
  }
});

test("trusted stream usage settles once, and replaying its evidence changes nothing", async () => {
  const g = await gatewayFixture({ inputTokens: 30, outputTokens: 10 });
  try {
    const reply = await g.call(textRequest({ stream: true }));
    const events = await reply.text();
    expect(events).toContain("response.completed");
    await until(async () => (await g.invocations())[0]?.state === "settled");
    const [record] = await g.invocations();
    if (!record?.evidence) throw new Error("Missing settlement evidence");
    expect(record.responseId).toBe(record.evidence.responseId);
    await g.f.store.managed.budgets.settle({ ...record.evidence, observedAt: new Date() });
    expect(await g.usage()).toMatchObject({
      settledInputTokens: 30,
      settledOutputTokens: 10,
      heldInputTokens: 0,
      unresolvedInvocations: 0,
    });
  } finally {
    await g.dispose();
  }
});

test("a client that disconnects mid-stream does not stop usage from settling", async () => {
  const g = await gatewayFixture({ inputTokens: 30, outputTokens: 10 });
  try {
    g.provider.setMode("hold");
    const client = new AbortController();
    const reply = await g.call(textRequest({ stream: true }), {
      signal: client.signal,
      headers: { authorization: "Bearer pcw-fixture-workspace-grant", "content-type": "application/json" },
    });
    const reader = reply.body?.getReader();
    await reader?.read();
    await until(async () => (await g.invocations())[0]?.responseId !== undefined);
    expect((await g.invocations())[0]?.state).toBe("send_claimed");
    client.abort();
    await until(() => g.provider.heldCount() === 1);
    g.provider.release();
    await until(async () => (await g.invocations())[0]?.state === "settled");
    expect((await g.usage()).settledOutputTokens).toBe(10);
  } finally {
    await g.dispose();
  }
});

test("restart reconciliation abandons unclaimed calls and keeps claimed calls uncertain", async () => {
  const g = await gatewayFixture();
  try {
    const budgets = g.f.store.managed.budgets;
    const reserve = async () => {
      const identity = { ...g.grant.identity, invocationId: randomUUID() };
      await budgets.reserve({
        identity,
        workspaceId: g.grant.workspaceId,
        model: "fixture/model",
        requestDigest: `sha256:${"c".repeat(64)}`,
        countEvidenceRef: "openai-input-tokens:fixture",
        inputTokens: 25,
        requestedOutputTokens: 10,
      });
      return identity;
    };
    await reserve();
    const claimed = await reserve();
    // The gateway stopped after its send claim. Whether the provider saw the call is unknown.
    expect(await budgets.claimSend(claimed)).toBe(true);
    expect(await reconcileGatewayInvocations(budgets)).toEqual({ abandoned: 1, uncertain: 1 });
    expect(await budgets.claimSend(claimed)).toBe(false);
    expect(g.provider.generations()).toHaveLength(0);
    expect(await g.usage()).toMatchObject({ heldInputTokens: 25, unresolvedInvocations: 1 });
  } finally {
    await g.dispose();
  }
});
