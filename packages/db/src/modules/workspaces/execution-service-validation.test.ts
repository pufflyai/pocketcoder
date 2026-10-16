import { expect, test } from "bun:test";
import { executionFixture } from "./execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "./execution-service-fixture.test";

const invalidRoutes = ["accept", "lookup", "cancel", "ack"].flatMap((action) =>
  ["missing", "method", "response-mode"].map((defect) => [action, defect] as const),
);

test.each(invalidRoutes)("service acceptance rejects %s route with %s", async (action, defect) => {
  const f = await executionFixture((source) => {
    serviceExecutionTemplate(source);
    const service = source.spec.services.agent;
    if (!service) throw new Error("Fixture service missing");
    const route = service.routes.find((r) => r.path === `/executions/${action}`);
    if (!route) throw new Error("Fixture route missing");
    if (defect === "missing") service.routes = service.routes.filter((r) => r !== route);
    if (defect === "method") route.method = "GET";
    if (defect === "response-mode") route.responseMode = "stream";
  });
  try {
    const input = f.acceptance();
    await expect(
      f.store.executions.accept(input, new Date(), executionConversationIdentity(input.execution.requestId)),
    ).rejects.toThrow(`buffered POST /executions/${action}`);
    expect(await f.store.executions.get(input.execution)).toBeNull();
    expect(await f.store.inputs.getManifest(input.execution.requestId)).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("dispatch refuses a previously accepted service intent without an acknowledgment route", async () => {
  const f = await executionFixture((source) => {
    serviceExecutionTemplate(source);
    const service = source.spec.services.agent;
    if (!service) throw new Error("Fixture service missing");
    service.routes = service.routes.filter((route) => route.path !== "/executions/ack");
  });
  try {
    const input = f.acceptance();
    const identity = executionConversationIdentity(input.execution.requestId);
    const at = new Date();
    // Earlier controllers could persist this intent without checking protocol routes.
    await f.context.db.insert(f.context.tables.conversationRequests).values({
      principalId: input.callerPrincipalId,
      conversationId: identity.conversation_id,
      requestId: identity.request_id,
      identity,
      acceptedAt: at,
      execution: {
        acceptance: input,
        conversationIdentity: identity,
        outcome: null,
        acceptedAt: at.toISOString(),
        dispatchClaimedAt: null,
        phase: "accepted",
        cancel: null,
        settledAt: null,
        acknowledgedAt: null,
        finalizedAt: null,
      },
    });
    await f.context.db.insert(f.context.tables.inputManifests).values({
      id: input.execution.requestId,
      manifest: input.inputs,
      finalizedAt: null,
    });
    expect(await f.store.executions.claim(input.execution, at)).toBeNull();
    expect((await f.store.executions.get(input.execution))?.phase).toBe("lost");
  } finally {
    await f.dispose();
  }
});
