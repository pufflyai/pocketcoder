import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managed } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory, managedPolicy } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

async function managedServer(options: { stop?: number } = {}) {
  const store = await createStore();
  const server = await createTestServer(store, {}, undefined, {
    sessionQueueLimits: { count: 4, bytes: 1048576 },
    sessionEventPollMs: 10,
    ...(options.stop ? { sessionStopSeconds: options.stop } : {}),
  });
  const caller = await store.getMachineKeyWithPrincipal(server.keyId);
  if (!caller) throw Error("Missing caller");
  await store.updatePrincipal(caller.principal.id, ["admin"], ["*"]);
  const scopeId = randomUUID();
  const profileId = randomUUID();
  const template = (await store.listTemplates(null))[0];
  if (!template) throw Error("Missing template");
  await store.managed.authority.registerScope(server.keyId, scopeId, caller.principal.id, true);
  await store.managed.authority.provisionProfile(server.keyId, caller.principal.id, {
    profileId,
    revision: 1,
    isolationScopeId: randomUUID(),
    budgetScopeIds: [scopeId],
    templateDigest: template.digest,
    allowedModels: ["local/model"],
    credentialBindingId: null,
  });
  await store.managed.budgets.writePolicy(server.keyId, managedPolicy(scopeId), null);
  const request = (path: string, method = "GET", body?: unknown) =>
    server.app.request(
      path,
      authed(server.token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    );
  const sessionId = randomUUID();
  await request("/v1/sessions", "POST", { sessionId, profileId, profileRevision: 1 });
  return { server, request, sessionId };
}

test("cancel and close routes return pending or completed receipts and need an explicit deadline", async () => {
  const unconfigured = await managedServer();
  const missing = await unconfigured.request(`/v1/sessions/${unconfigured.sessionId}/close`, "POST", {
    cancelId: randomUUID(),
  });
  expect(missing.status).toBe(503);

  const { request, sessionId } = await managedServer({ stop: 30 });
  const requestId = randomUUID();
  const body = {
    requestId,
    message: "queued",
    attachments: [],
    dispatchDeadline: new Date(Date.now() + 60000).toISOString(),
  };
  expect((await request(`/v1/sessions/${sessionId}/requests`, "POST", body)).status).toBe(200);
  const cancelId = randomUUID();
  const canceled = await request(`/v1/sessions/${sessionId}/requests/${requestId}/cancel`, "POST", { cancelId });
  expect(canceled.status).toBe(200);
  expect(managed.CancelReceiptSchema.parse(await canceled.json())).toMatchObject({ state: "completed", cancelId });
  const closed = await request(`/v1/sessions/${sessionId}/close`, "POST", { cancelId: randomUUID() });
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ scope: "session", state: "completed" });
  const after = await request(`/v1/sessions/${sessionId}/requests`, "POST", { ...body, requestId: randomUUID() });
  expect(after.status).toBe(409);
  expect(await after.json()).toMatchObject({ error: { code: "session.closed" } });
  expect((await request(`/v1/sessions/${sessionId}/requests/${requestId}`)).status).toBe(200);
});

test("history returns a watermark and the event stream resumes after it", async () => {
  const { request, sessionId } = await managedServer({ stop: 30 });
  const history = await request(`/v1/sessions/${sessionId}/history?limit=10`);
  expect(history.status).toBe(200);
  const page = managed.ManagedHistoryPageSchema.parse(await history.json());
  expect(page).toMatchObject({ records: [], nextCursor: null });

  const stream = await request(`/v1/sessions/${sessionId}/events?after=${encodeURIComponent(page.eventCursor)}`);
  expect(stream.status).toBe(200);
  const reader = stream.body?.getReader();
  if (!reader) throw Error("Missing stream");
  const requestId = randomUUID();
  await request(`/v1/sessions/${sessionId}/requests`, "POST", {
    requestId,
    message: "hello",
    attachments: [],
    dispatchDeadline: new Date(Date.now() + 60000).toISOString(),
  });
  let text = "";
  while (!text.includes(requestId)) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const frame = text.split("\n\n").find((part) => part.includes(requestId)) ?? "";
  expect(frame).toContain("event: request.updated");
  const id = frame.match(/^id: (.+)$/m)?.[1];
  expect(id).toBe(`${sessionId}:2`);
  // Disconnecting did not touch the work; a reconnect from the last id sees nothing new yet.
  expect((await request(`/v1/sessions/${sessionId}/requests/${requestId}`)).status).toBe(200);
  const foreign = await request(`/v1/sessions/${sessionId}/events?after=${randomUUID()}:1`);
  expect(foreign.status).toBe(400);
  expect(await foreign.json()).toMatchObject({ error: { code: "events.cursor_invalid" } });
});
