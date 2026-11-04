import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, ProviderNotSubmittedError, Scheduler, type WorkspaceDriver } from "../index";

const createStore = createTestStoreFactory();

// A Kubernetes-like driver: cleanup of a launch without a receipt cannot prove that nothing was created.
async function launchFixture(create: WorkspaceDriver["create"]) {
  const store = await createStore();
  const provider = new FakeDriver();
  let now = new Date("2026-11-04T08:00:00Z");
  const absenceChecks: Date[] = [];
  let absenceProved = false;
  const driver: WorkspaceDriver = {
    kind: provider.kind,
    create,
    createWarm: (launch) => provider.createWarm(launch),
    inspect: (ref) => provider.inspect(ref),
    list: () => provider.list(),
    listWarm: () => provider.listWarm(),
    purgeInput: (id) => provider.purgeInput(id),
    stop: (ref) => provider.stop(ref),
    remove: (ref) => provider.remove(ref),
    async uncommittedProvider(workspace) {
      absenceChecks.push(now);
      if (!absenceProved) throw new Error("provider absence is unproved");
      return { kind: provider.kind, id: workspace.id };
    },
  };
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
    deadlineAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
  });
  if (inserted.kind === "capacity_exceeded") throw new Error("unexpected capacity");
  const scheduler = new Scheduler({
    store,
    driver,
    now: () => now,
    onError: () => {},
    connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
    secrets: { generate: () => randomUUID(), digest: (s: string) => new TextEncoder().encode(s) },
    limits: { ...DEFAULT_LIMITS, maxLaunchAttempts: 2 },
    workspaceServerUrl: "http://localhost",
  });
  return {
    store,
    scheduler,
    workspaceId: inserted.workspace.id,
    absenceChecks,
    proveAbsence: () => {
      absenceProved = true;
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test("a launch that fails before submitting anything fails promptly with its reason and needs no cleanup", async () => {
  const f = await launchFixture(async () => {
    throw new ProviderNotSubmittedError(new Error("NFS endpoint is not isolated from workloads"));
  });
  for (let tick = 0; tick < 2; tick++) {
    await f.scheduler.tick();
    f.advance(1_000);
  }
  const workspace = await f.store.getWorkspace(f.workspaceId);
  expect(workspace?.state).toBe("failed");
  expect(workspace?.reasonCode).toBe("launch_failed");
  expect(workspace?.failureLogTail).toContain("NFS endpoint is not isolated from workloads");
  expect(f.absenceChecks).toHaveLength(0);
});

test("cleanup that cannot prove absence backs off, then settles once absence is proved", async () => {
  const f = await launchFixture(async () => {
    throw new Error("provider request outcome unknown");
  });
  // Ten minutes of one-second scheduler ticks while the provider cannot answer.
  for (let tick = 0; tick < 600; tick++) {
    await f.scheduler.tick();
    f.advance(1_000);
  }
  expect(f.absenceChecks.length).toBeGreaterThan(3);
  expect(f.absenceChecks.length).toBeLessThan(20);

  f.proveAbsence();
  // At most one capped retry pause later.
  for (let tick = 0; tick < 360; tick++) {
    await f.scheduler.tick();
    f.advance(1_000);
  }
  expect((await f.store.getWorkspace(f.workspaceId))?.terminalAt).not.toBeNull();
});
