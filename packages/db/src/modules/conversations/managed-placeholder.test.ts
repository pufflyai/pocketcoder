import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertTestWorkspace } from "../../test-fixtures";
import { managedFixture, provision } from "../managed/fixture.test";

test("another principal's managed request cannot suppress an interrupted turn", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const requestId = randomUUID();
    await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId, message: "managed", attachments: [] },
      { count: 2, bytes: 1048576 },
    );
    const principal = await f.store.createPrincipal("other-owner", ["admin"], ["*"]);
    const workspace = await insertTestWorkspace({ ...f, principal }, "ordinary");
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: f.sessionId,
      request_id: requestId,
      turn_id: randomUUID(),
      request_fingerprint: "a".repeat(64),
    };
    await f.store.acceptConversationRequest(workspace.id, identity, new Date());
    const result = await f.store.commitConversationTurn({
      workspaceId: workspace.id,
      identity,
      status: "interrupted",
      reason: "controller_restarted",
      messages: [],
      startedAt: null,
      endedAt: new Date(),
    });
    expect(result.created).toBe(true);
    expect(result.record?.document.status).toBe("interrupted");
    expect(await f.store.getConversation(principal.id, f.sessionId)).toMatchObject({ recordCount: 1 });
  } finally {
    await f.dispose();
  }
});
