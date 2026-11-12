import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, Scheduler } from "../index";

const createStore = createTestStoreFactory();

async function credentialLaunch(workspaceIssuer: boolean) {
  const store = await createStore();
  const driver = new FakeDriver();
  const echo = fixtureTemplateEcho().manifest;
  const parsed = parseTemplateManifest({
    ...echo,
    spec: { ...echo.spec, env: { TOKEN_FILE: "secretRef:runtime" } },
  });
  const principal = await store.createPrincipal("test", ["admin"], ["*"]);
  const template = (
    await store.upsertTemplate({
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.spec.version,
      digest: parsed.digest,
      description: null,
      spec: parsed.manifest.spec,
    })
  ).row;
  const id = randomUUID();
  const inserted = await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: digestOf({ id }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: {},
    metadata: {},
    deadlineAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
  });
  if (inserted.kind === "capacity_exceeded") throw new Error("unexpected capacity");
  const scheduler = new Scheduler({
    store,
    driver,
    workspaceIssuer,
    revokeWorkspaceLeases: async () => {},
    onError: () => {},
    connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
    secrets: { generate: () => randomUUID(), digest: (s: string) => new TextEncoder().encode(s) },
    limits: { ...DEFAULT_LIMITS, maxLaunchAttempts: 1 },
    workspaceServerUrl: "http://localhost",
  });
  await scheduler.tick();
  return { workspace: await store.getWorkspace(id), driver };
}

// Session leases do not make a workspace issuer. Only the controller vault can mint workspace credentials.
test("a workspace credential reference is refused before launch when no workspace issuer is configured", async () => {
  const { workspace, driver } = await credentialLaunch(false);
  expect(driver.created).toHaveLength(0);
  expect(workspace?.providerRef).toBeNull();
  expect(workspace?.state).toBe("failed");
});

test("a workspace credential reference launches when a workspace issuer is configured", async () => {
  const { workspace, driver } = await credentialLaunch(true);
  expect(driver.created).toHaveLength(1);
  expect(workspace?.providerRef).not.toBeNull();
});
