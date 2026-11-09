import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindCompute, managedFixture, provision } from "../managed/fixture.test";

test("open invocations list unsent and unsettled calls, and a response identity is kept once", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspaceId = await bindCompute(f);
    const identity = (invocationId = randomUUID()) => ({
      principalId: f.principal.id,
      sessionId: f.sessionId,
      requestId: randomUUID(),
      invocationId,
    });
    const reserve = (id: ReturnType<typeof identity>) =>
      f.store.managed.budgets.reserve({
        identity: id,
        workspaceId,
        model: "fixture/model",
        requestDigest: `sha256:${"b".repeat(64)}`,
        countEvidenceRef: "count/1",
        inputTokens: 1,
        requestedOutputTokens: 1,
      });
    const unsent = identity();
    const sent = identity();
    const settled = identity();
    // The fixture policy allows two calls in flight, so the settled call finishes first.
    await reserve(settled);
    await f.store.managed.budgets.claimSend(settled);
    await f.store.managed.budgets.settle({
      identity: settled,
      provider: "local",
      providerAccountId: "fixture",
      responseId: "resp_settled",
      inputTokens: 1,
      outputTokens: 1,
      providerEvidenceRef: "fixture/settled",
      observedAt: new Date(),
    });
    await reserve(unsent);
    await reserve(sent);
    await f.store.managed.budgets.claimSend(sent);
    await expect(f.store.managed.budgets.observeResponse(unsent, "resp_unsent")).rejects.toMatchObject({
      code: "budget.conflict",
    });
    await f.store.managed.budgets.observeResponse(sent, "resp_1");
    await f.store.managed.budgets.observeResponse(sent, "resp_1");
    await expect(f.store.managed.budgets.observeResponse(sent, "resp_2")).rejects.toMatchObject({
      code: "budget.conflict",
    });
    const open = await f.store.managed.budgets.openInvocations();
    expect(open.map((item) => [item.identity.invocationId, item.state]).sort()).toEqual(
      [
        [unsent.invocationId, "reserved"],
        [sent.invocationId, "send_claimed"],
      ].sort(),
    );
  } finally {
    await f.dispose();
  }
});
