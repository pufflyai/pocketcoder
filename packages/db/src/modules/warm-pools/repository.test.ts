import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture } from "../../test-fixtures";

test("warm drain retries retain their first cleanup time while saving provider evidence", async () => {
  const f = await createPGliteFixture("pc53-warm-drain");
  try {
    const at = new Date();
    const id = randomUUID();
    await f.store.insertWarmPoolRuntime({
      id,
      templateId: f.template.id,
      templateName: f.template.name,
      templateVersion: f.template.version,
      templateDigest: f.template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "fixture",
      state: "ready",
      providerRef: { id: "owned-job" },
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: null,
      createdAt: at,
      updatedAt: at,
      readyAt: at,
      leasedAt: null,
      failureCode: null,
    });
    const started = new Date(at.getTime() + 1000);
    await f.store.updateWarmPoolRuntime(id, { state: "draining", failureCode: "provider_cleanup" }, started);
    await f.store.updateWarmPoolRuntime(
      id,
      { state: "draining", failureCode: "provider_cleanup" },
      new Date(at.getTime() + 2000),
    );
    await f.store.updateWarmPoolRuntime(
      id,
      { providerRef: { id: "owned-job", evidence: "observed-exit" } },
      new Date(at.getTime() + 3000),
    );
    const pending = await f.store.getWarmPoolRuntime(id);
    expect(pending?.updatedAt).toEqual(started);
    expect(pending?.providerRef?.evidence).toBe("observed-exit");
    const completed = new Date(at.getTime() + 4000);
    await f.store.updateWarmPoolRuntime(id, { state: "failed" }, completed);
    expect((await f.store.getWarmPoolRuntime(id))?.updatedAt).toEqual(completed);
  } finally {
    await f.dispose();
  }
}, 20_000);
