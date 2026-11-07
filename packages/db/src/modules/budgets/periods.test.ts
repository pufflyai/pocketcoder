import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseStore } from "../../store";
import { bindCompute, managedFixture, policy, provision } from "../managed/fixture.test";
import { createManagedBudgets } from "./budgets";

test.each(["utc_day", "utc_month"] as const)(
  "%s carries unknown holds after restart, late settlement and backward clock moves",
  async (period) => {
    const f = await managedFixture("disk");
    let store = f.store;
    try {
      await provision(f);
      const workspaceId = await bindCompute(f);
      await store.managed.budgets.writePolicy(f.keyId, { ...policy(f.scopeId, 2), period }, 1);
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() + 1, 1);
      start.setUTCHours(0, 0, 0, 0);
      let at = new Date(start.getTime() - 1000);
      // The physical fixture explicitly lives across the boundary; no real timer wait.
      const { eq } = await import("drizzle-orm");
      await f.context.db
        .update(f.context.tables.workspaces)
        .set({ deadlineAt: new Date(start.getTime() + 120_000) })
        .where(eq(f.context.tables.workspaces.id, workspaceId));
      let budgets = createManagedBudgets(store.context, () => at);
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
        inputTokens: 30,
        requestedOutputTokens: 20,
      };
      await budgets.reserve(input);
      expect((await budgets.usage(f.keyId, f.scopeId)).oldestUnresolvedAt).toBeNull();
      await budgets.claimSend(identity);
      await budgets.retainUncertain(identity);
      const before = await budgets.usage(f.keyId, f.scopeId);
      expect(before).toMatchObject({ heldInputTokens: 30, inFlightModelRequests: 1, unresolvedInvocations: 1 });
      await store.close();
      store = await DatabaseStore.openPGlite(f.directory);
      at = new Date(start.getTime() + 1000);
      budgets = createManagedBudgets(store.context, () => at);
      const after = await budgets.usage(f.keyId, f.scopeId);
      expect(after.periodStart).not.toBe(before.periodStart);
      expect(after.heldInputTokens).toBe(30);
      at = new Date(start.getTime() - 500);
      expect((await budgets.usage(f.keyId, f.scopeId)).periodStart).toBe(after.periodStart);
      at = new Date(start.getTime() + 2000);
      const evidence = {
        identity,
        inputTokens: 28,
        outputTokens: 12,
        provider: "local",
        providerAccountId: "fixture",
        responseId: randomUUID(),
        providerEvidenceRef: "fixture/terminal",
        observedAt: at,
      };
      await budgets.settle(evidence);
      await budgets.settle({ ...evidence, observedAt: new Date(at.getTime() + 1) });
      expect(await budgets.usage(f.keyId, f.scopeId)).toMatchObject({
        settledInputTokens: 28,
        settledOutputTokens: 12,
        heldInputTokens: 0,
        inFlightModelRequests: 0,
      });
      const records = await store.context.db.select().from(store.context.tables.budgetInvocations);
      const { exposure } = await import("./accounting");
      expect(
        exposure(
          records.map((r) => r.record),
          f.scopeId,
          { ...policy(f.scopeId, 2), period, effectiveAt: at.toISOString() },
          new Date(start.getTime() - 1000),
        ).settledOutput,
      ).toBe(12);
    } finally {
      if (store !== f.store) await store.close();
      await f.dispose();
    }
  },
);
