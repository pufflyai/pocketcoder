import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

test("template key grants narrow catalog and creation and follow live principal reductions", async () => {
  const app = await createTestServer(await createStore());
  const principal = await app.store.createPrincipal(
    "template-owner",
    ["templates:read", "workspaces:create", "workspaces:read"],
    ["*"],
  );
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes: principal.scopes,
    templateNames: ["fixture-echo"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.app.request(path, authed(key.token, { ...init, headers: { "idempotency-key": crypto.randomUUID() } }));
  const listed = await request("/v1/templates");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ items: [{ name: "fixture-echo" }] });
  expect((await request("/v1/templates/fixture-terminal")).status).toBe(404);
  expect(
    (
      await request("/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          external_id: "denied-template",
          template: { name: "fixture-terminal" },
          launch_input: {},
        }),
      })
    ).status,
  ).toBe(403);
  expect((await request("/v1/workspaces", { method: "POST", body: createTestBody("permitted-template") })).status).toBe(
    201,
  );
  await app.store.updatePrincipal(principal.id, principal.scopes, []);
  expect(await (await request("/v1/templates")).json()).toMatchObject({ items: [] });
  expect((await request("/v1/workspaces", { method: "POST", body: createTestBody("reduced-template") })).status).toBe(
    403,
  );
  await app.store.updatePrincipal(principal.id, ["templates:read"], ["fixture-echo"]);
  expect((await request("/v1/workspaces")).status).toBe(403);
});
