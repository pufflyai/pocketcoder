import { expect, test } from "bun:test";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import type { KubernetesPlacementConfig } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { authed, createTestBody, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { registerServerTestCleanup } from "../testing/test-server-cleanup";
import { templatePlacementPolicy } from "./placement-policy";

const createStore = createTestStoreFactory();

test("queued work cannot launch after its operator placement is removed", async () => {
  const { store, driver, token } = await createTestServer(await createStore());
  const original = fixtureTemplateEcho().manifest;
  const parsed = parseTemplateManifest({
    ...original,
    metadata: original.metadata,
    spec: { ...original.spec, version: "1.0.1", placement: "arm" },
  });
  await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const config: KubernetesPlacementConfig = {
    placementProfiles: { default: {}, arm: {} },
    templatePlacement: { "fixture-echo": ["arm"] },
    vmRuntimeHandlers: [],
  };
  let externalAllowed = false;
  const server = buildServer({
    store,
    driver,
    pepper: SERVER_TEST_PEPPER,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://runtime",
    checkPlacement: templatePlacementPolicy(config, "kubernetes"),
    authorizeLaunch: async () => externalAllowed,
  });
  registerServerTestCleanup(store, server);
  const body = JSON.parse(createTestBody("queued-placement"));
  body.template = { name: "fixture-echo", version: "1.0.1" };
  const response = await server.app.request(
    "/v1/workspaces",
    authed(token, { method: "POST", headers: { "idempotency-key": "placement-removed" }, body: JSON.stringify(body) }),
  );
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await server.scheduler.tick();
  delete config.placementProfiles.arm;
  externalAllowed = true;
  await server.scheduler.tick();
  expect(driver.inputFor(id)).toBeUndefined();
  expect((await store.getWorkspace(id))?.state).toBe("queued");
});
