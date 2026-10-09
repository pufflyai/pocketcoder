import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { authed, createTestBody, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { registerServerTestCleanup } from "../testing/test-server-cleanup";

const createStore = createTestStoreFactory();

test("authenticated workspace creation reaches the configured admission hook before provisioning", async () => {
  const { store, driver, token } = await createTestServer(await createStore());
  let allowed = false;
  const seen: string[] = [];
  const server = buildServer({
    store,
    driver,
    pepper: SERVER_TEST_PEPPER,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://runtime",
    authorizeLaunch: async (row) => {
      seen.push(row.id);
      return allowed;
    },
  });
  registerServerTestCleanup(store, server);
  const response = await server.app.request(
    "/v1/workspaces",
    authed(token, {
      method: "POST",
      headers: { "idempotency-key": "guarded" },
      body: createTestBody("task"),
    }),
  );
  expect(response.status).toBe(201);
  const workspace = (await response.json()) as { id: string };
  await server.scheduler.tick();
  expect(seen).toContain(workspace.id);
  expect(driver.inputFor(workspace.id)).toBeUndefined();
  allowed = true;
  await server.scheduler.tick();
  expect(driver.inputFor(workspace.id)?.workspace_id).toBe(workspace.id);
});
