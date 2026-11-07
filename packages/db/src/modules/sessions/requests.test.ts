import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertTestWorkspace } from "../../test-fixtures";
import { managedFixture, provision } from "../managed/fixture.test";
import { executionConversationIdentity } from "../workspaces/execution-service-fixture.test";

test("logical requests queue without compute, replay once and reject changed input", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const input = {
      requestId: randomUUID(),
      message: "run tests",
      attachments: [],
      dispatchDeadline: new Date(Date.now() + 60000).toISOString(),
    };
    const requests = f.store.managed.requests;
    const accepted = await requests.accept(f.keyId, f.sessionId, input, { count: 2, bytes: 1024 });
    expect(accepted.replayed).toBe(false);
    expect(accepted.request.state).toBe("accepted");
    expect(accepted.request.collection.state).toBe("pending");
    expect(await requests.accept(f.keyId, f.sessionId, input, { count: 2, bytes: 1024 })).toEqual({
      ...accepted,
      replayed: true,
    });
    await expect(
      requests.accept(f.keyId, f.sessionId, { ...input, message: "changed" }, { count: 2, bytes: 1024 }),
    ).rejects.toThrow("identity");
    await requests.accept(f.keyId, f.sessionId, { ...input, requestId: randomUUID() }, { count: 2, bytes: 1024 });
    await expect(
      requests.accept(f.keyId, f.sessionId, { ...input, requestId: randomUUID() }, { count: 2, bytes: 1024 }),
    ).rejects.toThrow("queue");
    expect(await requests.get(f.keyId, f.sessionId, input.requestId)).toEqual(accepted.request);
  } finally {
    await f.dispose();
  }
});

test("legacy receipts cannot reserve or retarget managed request identities", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const workspace = await insertTestWorkspace(f, randomUUID());
    const requestId = randomUUID();
    const legacy = { ...executionConversationIdentity(requestId), conversation_id: f.sessionId };
    await expect(f.store.acceptConversationRequest(workspace.id, legacy, new Date())).rejects.toThrow("logical");
    const accepted = await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      { requestId, message: "run", attachments: [], dispatchDeadline: new Date(Date.now() + 60000).toISOString() },
      { count: 1, bytes: 1024 },
    );
    await expect(
      f.store.acceptConversationRequest(workspace.id, { ...legacy, turn_id: accepted.request.turnId }, new Date()),
    ).rejects.toThrow("logical");
    expect((await f.store.managed.requests.get(f.keyId, f.sessionId, requestId)).turnId).toBe(accepted.request.turnId);
  } finally {
    await f.dispose();
  }
});
