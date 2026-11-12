import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managed } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();
test("configured session profiles work without admin and keep existing chats after removal", async () => {
  const store = await createStore(),
    server = await createTestServer(store);
  const caller = await store.getMachineKeyWithPrincipal(server.keyId);
  if (!caller) throw Error("Missing caller");
  const template = (await store.listTemplates(null))[0]!;
  await store.managed.profiles.reconcile(
    caller.principal.id,
    { chat: managed.ProfileConfigSchema.parse({ template: template.name }) },
    {},
  );
  await store.updatePrincipal(caller.principal.id, ["sessions:read", "sessions:write"], ["*"]);
  const request = (path: string, method = "GET", body?: unknown) =>
    server.app.request(
      path,
      authed(server.token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    );
  const input = { sessionId: randomUUID(), profile: "chat", owner: "alice", group: "client" };
  expect((await request("/v1/sessions", "POST", { padding: "x".repeat(262144) })).status).toBe(413);
  const created = await request("/v1/sessions", "POST", input);
  expect(created.status).toBe(200);
  const first = await created.json();
  expect(await (await request("/v1/sessions", "POST", input)).json()).toEqual(first);
  expect((await request("/v1/sessions", "POST", { ...input, group: "other" })).status).toBe(409);
  expect(await (await request("/v1/session-profiles/chat")).json()).toMatchObject({
    templateVersion: template.version,
    disabled: false,
  });
  expect(await (await request("/v1/sessions?owner=alice&state=open")).json()).toMatchObject([
    { sessionId: input.sessionId, owner: "alice" },
  ]);
  await store.managed.profiles.reconcile(caller.principal.id, {}, {});
  expect((await request("/v1/sessions", "POST", { ...input, sessionId: randomUUID() })).status).toBe(404);
  expect((await request(`/v1/sessions/${input.sessionId}`)).status).toBe(200);
  expect((await request(`/v1/sessions/${randomUUID()}`)).status).toBe(404);
});
