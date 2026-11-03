import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, Scheduler } from "../index";

const createStore = createTestStoreFactory();

test("scheduler observes provisioning providers before cancellation and still enforces deadlines when inspection fails", async () => {
  const store = await createStore();
  const provider = new FakeDriver();
  let inspected = 0;
  let unavailable = false;
  // Provider API boundary: observation must not bypass lifecycle enforcement.
  provider.inspect = async () => {
    inspected++;
    if (unavailable) throw new Error("provider unavailable");
    return { exists: true, running: true, exitCode: null };
  };
  let now = new Date("2026-09-18T12:00:00Z");
  const principal = await store.createPrincipal("test", ["admin"], ["*"]);
  const parsed = fixtureTemplateEcho();
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
  await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: digestOf({ id }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: {},
    metadata: {},
    deadlineAt: new Date(now.getTime() + 3600000),
    createdAt: now,
  });
  const scheduler = new Scheduler({
    store,
    driver: provider,
    now: () => now,
    onError: () => {},
    connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
    secrets: { generate: () => randomUUID(), digest: (s: string) => new TextEncoder().encode(s) },
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://localhost",
  });
  await scheduler.tick();
  await scheduler.sweep();
  expect(inspected).toBe(1);
  expect((await store.getWorkspace(id))?.state).toBe("provisioning");
  unavailable = true;
  now = new Date(now.getTime() + 7200000);
  await scheduler.sweep();
  expect((await store.getWorkspace(id))?.state).not.toBe("provisioning");
});

test("a launch the provider refuses fails promptly as launch_refused and stops its provider", async () => {
  const store = await createStore();
  const provider = new FakeDriver();
  provider.refuseLaunches = true;
  const now = new Date("2026-09-18T12:00:00Z");
  const principal = await store.createPrincipal("test", ["admin"], ["*"]);
  const parsed = fixtureTemplateEcho();
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
  await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: digestOf({ id }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: {},
    metadata: {},
    deadlineAt: new Date(now.getTime() + 3600000),
    createdAt: now,
  });
  const scheduler = new Scheduler({
    store,
    driver: provider,
    now: () => now,
    onError: () => {},
    connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
    secrets: { generate: () => randomUUID(), digest: (s: string) => new TextEncoder().encode(s) },
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://localhost",
  });
  await scheduler.tick();
  // Well before the start timeout: the refusal alone ends the launch.
  await scheduler.sweep();
  expect(await store.getWorkspace(id)).toMatchObject({ state: "failed", reasonCode: "launch_refused" });
  expect(provider.stopped).toHaveLength(1);
});
