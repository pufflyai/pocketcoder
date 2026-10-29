import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionFixture } from "./execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "./execution-service-fixture.test";

test.each([false, true])(
  "request IDs stay independent across workspaces and different principal=%s",
  async (differentPrincipal) => {
    const f = await executionFixture(serviceExecutionTemplate);
    const principal = differentPrincipal ? await f.store.createPrincipal("other", ["admin"], ["*"]) : f.principal;
    const g = await executionFixture(serviceExecutionTemplate, { base: { ...f, principal } });
    try {
      const id = randomUUID();
      const a = f.acceptance(id),
        b = g.acceptance(id);
      const first = await f.store.executions.accept(a, new Date(), executionConversationIdentity(id));
      const second = await f.store.executions.accept(b, new Date(), executionConversationIdentity(id));
      expect(first.kind).toBe("accepted");
      expect(second.kind).toBe("accepted");
      await f.store.executions.cancel(
        { execution: a.execution, cancelId: randomUUID(), scope: "operation" },
        new Date(),
      );
      expect(await f.store.executions.claim(b.execution, new Date())).not.toBeNull();
    } finally {
      await f.dispose();
    }
  },
);
