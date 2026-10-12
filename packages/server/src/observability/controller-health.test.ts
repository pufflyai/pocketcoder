import { expect, test } from "bun:test";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { Hub } from "../control-channel/hub";
import { controllerHealth } from "./controller-health";
import { Readiness } from "./health";

test("controller health reads durable work without exposing its content", async () => {
  const fixture = await createPGliteFixture("pc53-health", "disk");
  const directory = fixture.directory;
  if (!directory) throw new Error("The health fixture must use a real data folder.");
  try {
    const workspace = await insertTestWorkspace(fixture, "private-source-name", { secret: "private-content" });
    const now = new Date(workspace.createdAt.getTime() + 45_000);
    const health = await controllerHealth({
      store: fixture.store,
      hub: new Hub(),
      directory,
      readiness: new Readiness(),
      now,
    });
    expect(health.queue).toEqual({ count: 1, oldestSeconds: 45 });
    expect(health.heartbeat).toEqual({ missing: 0, oldestSeconds: 0 });
    expect(health.cleanup).toEqual({ count: 0, oldestSeconds: 0 });
    expect(health.disk.availableBytes).toBeGreaterThan(0);
    expect(health.journal.configured).toBe(false);
    await fixture.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at: now });
    expect(
      await fixture.store.transition(workspace.id, { from: ["provisioning"], to: "terminating", at: now }),
    ).not.toBeNull();
    const terminating = await controllerHealth({
      store: fixture.store,
      hub: new Hub(),
      directory,
      readiness: new Readiness(),
      now,
    });
    expect(terminating.cleanup).toEqual({ count: 1, oldestSeconds: 0 });
    const body = JSON.stringify(health);
    for (const hidden of [workspace.id, fixture.principal.name, "private-source-name", "private-content", directory])
      expect(body).not.toContain(hidden);
  } finally {
    await fixture.dispose();
  }
}, 20_000);
