import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { Hono } from "hono";
import { registerUsageRuntimeRoute } from "./usage-runtime";

test("private usage inventory distinguishes assigned warm runtimes without exposing enrollment credentials", async () => {
  const fixture = await createPGliteFixture("usage-claims");
  try {
    const workspace = await insertTestWorkspace(fixture, "assigned-warm");
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const at = new Date();
      await fixture.store.insertWarmPoolRuntime({
        id,
        templateId: fixture.template.id,
        templateName: fixture.template.name,
        templateVersion: fixture.template.version,
        templateDigest: fixture.template.digest,
        driverKind: "kubernetes",
        eligibilityFingerprint: "usage-test",
        state: index ? "leased" : "ready",
        providerRef: null,
        enrollmentDigest: new Uint8Array([1, 2, 3]),
        enrollmentExpiresAt: new Date(+at + 60_000),
        workspaceId: index ? workspace.id : null,
        createdAt: at,
        updatedAt: at,
        readyAt: at,
        leasedAt: null,
        failureCode: null,
      });
    }
    const app = new Hono();
    registerUsageRuntimeRoute(app, fixture.store);
    expect(await (await app.request("/v1/usage/warm-claims")).json()).toEqual({ claimed_warm_runtime_ids: [ids[1]] });
  } finally {
    await fixture.dispose();
  }
});
