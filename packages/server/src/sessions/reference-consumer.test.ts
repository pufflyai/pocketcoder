import { expect, test } from "bun:test";
import { ManagedRuntimeConsumer } from "../../../../examples/clients/managed-runtime/consumer";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { sdkClient } from "./sdk-fixture.test";

test("a consumer runs, replays, reads and stops chats with a sessions-only key and no stored intent", async () => {
  const producer = fakeProducer(),
    m = await managedFixture(producer.server.port);
  const { client } = await sdkClient(m);
  try {
    const first = await m.session(),
      second = await m.session();
    await m.f.store.updatePrincipal(m.f.principal.id, ["sessions:read", "sessions:write"], ["*"]);
    const users = new Map<string, string>([
      [first, "ada"],
      [second, "bob"],
    ]);
    const authorization = { canUse: (userId: string, sessionId: string) => users.get(sessionId) === userId };
    const consumer = new ManagedRuntimeConsumer(client, authorization);
    await expect(consumer.ask("bob", first, "not yours")).rejects.toThrow("Not authorized");
    const request = await consumer.ask("ada", first, "complete the first turn");
    await m.settle();
    expect((await consumer.waitFor("ada", first, request.requestId)).request.outcome).toBe("completed");
    const restarted = new ManagedRuntimeConsumer(client, authorization);
    expect(
      (await restarted.ask("ada", first, "complete the first turn", { requestId: request.requestId })).turnId,
    ).toBe(request.turnId);
    expect(producer.sent("complete the first turn")).toHaveLength(1);
    const running = await consumer.ask("ada", first, "run ada");
    const queued = await consumer.ask("ada", first, "run queued");
    const sibling = await consumer.ask("bob", second, "run bob");
    await m.settle();
    expect((await consumer.cancel("ada", first)).state).toBe("pending");
    await m.settle();
    expect((await consumer.waitFor("ada", first, running.requestId)).request.outcome).toBe("interrupted");
    expect((await client.requests.get(first, queued.requestId)).outcome).toBe("canceled");
    expect((await client.requests.get(second, sibling.requestId)).state).toBe("running");
    const feed = await consumer.transcript("ada", first);
    expect(feed.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("first turn")))).toBe(
      true,
    );
    expect((await consumer.close("ada", first)).scope).toBe("session");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
