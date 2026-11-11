import { expect, test } from "bun:test";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

test.each(["fenced", "never-sent"] as const)(
  "a %s native request keeps canonical terminal history without producer replay",
  async (mode) => {
    const f = await executionFixture(serviceExecutionTemplate);
    try {
      const input = f.acceptance();
      const identity = executionConversationIdentity(input.execution.requestId, f.id);
      await f.store.executions.accept(input, new Date(), identity);
      expect(await f.store.recordInterruptedTurns(new Date())).toBe(0);
      if (mode === "fenced") {
        await f.store.executions.claim(input.execution, new Date());
        await f.store.endWorkspaceRuntime(f.id, f.runtime.incarnationId, new Date());
      } else
        await f.store.executions.cancel(
          { execution: input.execution, cancelId: crypto.randomUUID(), scope: "operation" },
          new Date(),
        );
      const document = await f.store.getConversation(f.principal.id, identity.conversation_id);
      expect(document?.recordCount).toBe(1);
      const messages = await f.store.readConversationMessages(document!.id, 0, 100);
      expect(messages.at(-1)?.identity?.fact).toMatchObject({
        type: "turn_terminal",
        outcome: mode === "fenced" ? "lost" : "canceled",
      });
      expect((await f.store.executions.get(input.execution))?.finalizedAt).toBeString();
    } finally {
      await f.dispose();
    }
  },
);

test("a native producer may only write the workspace that owns its accepted execution", async () => {
  const f = await executionFixture(serviceExecutionTemplate);
  try {
    const other = await executionFixture(serviceExecutionTemplate, { base: f });
    const input = f.acceptance();
    const identity = executionConversationIdentity(input.execution.requestId, f.id);
    await f.store.executions.accept(input, new Date(), identity);
    expect(await f.store.isAcceptedTurn(f.id, identity)).toBe(true);
    expect(await f.store.isAcceptedTurn(other.id, identity)).toBe(false);
  } finally {
    await f.dispose();
  }
});
