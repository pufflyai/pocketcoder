import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { DEFAULT_LIMITS, Scheduler } from "../index";
import { noWorkspaceConnections, queue, secrets, seed } from "../warm-pool/warm-pool-fixtures.test";

const createStore = createTestStoreFactory();

test.each(["global", "principal", "template"] as const)(
  "reports the %s counter without releasing active work",
  async (scope) => {
    const store = await createStore();
    const seeded = await seed(store);
    const active = await queue(store, seeded, "active");
    await store.transition(active.id, { from: ["queued"], to: "provisioning", at: new Date() });
    const waiting = await queue(store, seeded, "waiting");
    const driver = new FakeDriver();
    const limits = {
      ...DEFAULT_LIMITS,
      globalActiveWorkspaces: scope === "global" ? 1 : 10,
      perPrincipalActiveWorkspaces: scope === "principal" ? 1 : 10,
      perTemplateActiveWorkspaces: scope === "template" ? { [seeded.template.name]: 1 } : {},
    };
    const scheduler = new Scheduler({
      store,
      driver,
      connections: noWorkspaceConnections,
      secrets,
      limits,
      workspaceServerUrl: "http://runtime",
    });
    await scheduler.admit();
    expect(await store.getWorkspace(waiting.id)).toMatchObject({
      state: "queued",
      reasonCode: `admission_${scope}_capacity`,
    });
    const cursor = (await store.getWorkspace(waiting.id))?.changeSeq;
    await scheduler.admit();
    expect((await store.getWorkspace(waiting.id))?.changeSeq).toBe(cursor);
    expect(await store.countActive()).toMatchObject({ global: 1 });
    expect((await store.getWorkspace(active.id))?.state).toBe("provisioning");
    expect(driver.created).toHaveLength(0);
  },
);
