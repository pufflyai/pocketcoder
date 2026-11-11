import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { eq } from "drizzle-orm";
import { ManagedRuntimeConsumer } from "../../../../examples/clients/managed-runtime/consumer";
import { IntentFile } from "../../../../examples/clients/managed-runtime/intents";
import { provision } from "../../../../examples/clients/managed-runtime/provision";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { createSessionRecovery } from "./recovery";
import { sdkClient } from "./sdk-fixture.test";

test("the independent reference consumer runs turns, reconnects, cancels and closes with only the SDK", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const { client } = await sdkClient(m);
  const directory = await mkdtemp(join(tmpdir(), "pc-reference-consumer-"));
  const launched: Awaited<ReturnType<typeof m.launch>>[] = [];
  // The placement owner launches compute; the fixture workspace stands in for the Docker launch.
  const recovery = createSessionRecovery({
    store: m.f.store,
    launcher: {
      async create(_principal, body) {
        const next = await m.launch();
        launched.push(next);
        await m.f.context.db
          .update(m.f.context.tables.workspaces)
          .set({ metadata: body.metadata ?? {} })
          .where(eq(m.f.context.tables.workspaces.id, next.id));
        return (await m.f.store.getWorkspace(next.id)) as WorkspaceRow;
      },
      stop: async () => {},
    },
  });
  const run = async () => {
    for (let i = 0; i < 3; i++) {
      await recovery.tick();
      for (const workspace of launched) {
        await workspace.dispatcher.tick();
        await workspace.dispatcher.drain();
      }
    }
  };
  try {
    const { scopeId, profile } = await provision(client, {
      principalId: m.f.principal.id,
      templateDigest: m.f.runtime.template.digest,
      installationScopeId: m.scopeId,
      limits: { workspaceStarts: 10, maxActiveWorkspaces: 3, maxChatProcessesPerWorkspace: 2 },
    });
    const intentsPath = join(directory, "intents.json");
    const users = new Map<string, string[]>();
    const consumer = new ManagedRuntimeConsumer(client, await IntentFile.open(intentsPath), {
      canUse: (userId, sessionId) => users.get(userId)?.includes(sessionId) ?? false,
    });
    const first = await consumer.startSession(profile);
    const second = await consumer.startSession(profile);
    users.set("ada", [first.sessionId]);
    users.set("bob", [second.sessionId]);
    await expect(consumer.ask("bob", first.sessionId, "not yours")).rejects.toThrow("Not authorized");

    const turn = await consumer.ask("ada", first.sessionId, "complete the first turn");
    await run();
    const result = await consumer.waitFor("ada", first.sessionId, turn.requestId);
    expect(result.request).toMatchObject({ outcome: "completed", finalResponse: "done:complete the first turn" });
    expect(result.collection.state).toBe("settled");

    // A restarted consumer resends its recorded intents; nothing runs twice.
    const restarted = new ManagedRuntimeConsumer(client, await IntentFile.open(intentsPath), {
      canUse: (userId, sessionId) => users.get(userId)?.includes(sessionId) ?? false,
    });
    expect((await restarted.resend(first.sessionId)).map((request) => request.turnId)).toEqual([turn.turnId]);
    expect(producer.sent("complete the first turn")).toHaveLength(1);

    // Cancelling one session's work leaves the sibling session running.
    const long = await consumer.ask("ada", first.sessionId, "run ada");
    const sibling = await consumer.ask("bob", second.sessionId, "run bob");
    await run();
    expect((await consumer.cancel("ada", first.sessionId, long.requestId)).state).toBe("pending");
    await run();
    const canceled = await consumer.waitFor("ada", first.sessionId, long.requestId);
    expect(canceled.request.outcome).toBe("interrupted");
    expect((await client.requests.get(second.sessionId, sibling.requestId)).state).toBe("running");

    expect((await consumer.transcript("ada", first.sessionId)).map((record) => record.status)).toEqual([
      "completed",
      "interrupted",
    ]);
    // Both sessions share one profile with room for two processes, so they run on one workspace.
    expect((await client.authority.usage(scopeId)).activeWorkspaces).toBe(1);
    expect((await consumer.close("ada", first.sessionId)).scope).toBe("session");
  } finally {
    for (const workspace of launched) await workspace.dispose();
    await m.f.dispose();
    await producer.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
