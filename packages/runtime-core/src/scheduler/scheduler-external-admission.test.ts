import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, Scheduler } from "../index";

const createStore = createTestStoreFactory();

// Policy callbacks are the external authorization boundary, not scheduler internals.
test.each(["create", "restore"] as const)(
  "external denial blocks %s before provisioning and retries safely",
  async (launchMode) => {
    const store = await createStore();
    const driver = new FakeDriver();
    const principal = await store.createPrincipal("backend", ["admin"], ["*"]);
    const fixture = fixtureTemplateEcho();
    const template = (
      await store.upsertTemplate({
        name: fixture.manifest.metadata.name,
        version: fixture.manifest.spec.version,
        digest: fixture.digest,
        description: null,
        spec: fixture.manifest.spec,
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
      templateSnapshot: snapshotOf(fixture),
      launchInput: null,
      metadata: { actor: "approved-user" },
      launchMode,
      deadlineAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    let decision: "deny" | "error" | "allow" = "deny";
    const observed: string[] = [];
    const scheduler = new Scheduler({
      store,
      driver,
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://runtime",
      connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
      secrets: { generate: () => "registration", digest: () => new Uint8Array([1]) },
      authorizeLaunch: async (row) => {
        observed.push(row.id);
        expect(row.principalId).toBe(principal.id);
        expect(row.metadata).toEqual({ actor: "approved-user" });
        if (decision === "error") throw new Error("policy unavailable");
        return decision === "allow";
      },
    });
    for (const next of ["deny", "error"] as const) {
      decision = next;
      await scheduler.tick();
      expect(driver.inputFor(id)).toBeUndefined();
      expect((await store.getWorkspace(id))?.state).toBe("queued");
    }
    decision = "allow";
    await scheduler.tick();
    expect(driver.inputFor(id)?.workspace_id).toBe(id);
    expect(observed).toEqual([id, id, id]);
  },
);
