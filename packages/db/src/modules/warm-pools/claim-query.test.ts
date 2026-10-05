import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

test.each(["memory", "disk"] as const)(
  "warm claim rejects an output snapshot changed without a cursor bump (%s)",
  async (mode) => {
    const fixture = await createPGliteFixture("warm_snapshot", mode);
    const { store, template } = fixture;
    try {
      const workspace = await insertTestWorkspace(fixture, "stale-warm-output");
      const runtimeId = randomUUID();
      const at = new Date();
      await store.insertWarmPoolRuntime({
        id: runtimeId,
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.version,
        templateDigest: template.digest,
        driverKind: "docker",
        eligibilityFingerprint: "sha256:eligible",
        state: "ready",
        providerRef: { kind: "docker", id: "warm-provider" },
        enrollmentDigest: null,
        enrollmentExpiresAt: null,
        workspaceId: null,
        createdAt: at,
        updatedAt: at,
        readyAt: at,
        leasedAt: null,
        failureCode: null,
      });
      await store.appendOutput({ workspaceId: workspace.id, name: "artifact", value: "new", seq: 0, occurredAt: at });
      const fresh = await store.getWorkspace(workspace.id);
      expect(fresh?.changeSeq).toBe(workspace.changeSeq);
      expect(fresh?.outputs).toEqual({ artifact: "new" });
      const claim = {
        workspace,
        driverKind: "docker",
        eligibilityFingerprint: "sha256:eligible",
        registrationDigest: new TextEncoder().encode("fresh-secret"),
        registrationExpiresAt: new Date(Date.now() + 60_000),
        at,
      };
      expect(await store.claimWarmPoolRuntime(claim)).toEqual({ kind: "stale" });
      expect(await store.getWarmPoolRuntime(runtimeId)).toMatchObject({ state: "ready", workspaceId: null });
      expect(await store.listStateHistory(workspace.id)).toHaveLength(1);
      if (!fresh) throw new Error("workspace not found");
      const claimed = await store.claimWarmPoolRuntime({ ...claim, workspace: fresh });
      expect(claimed).toMatchObject({ workspace: { id: workspace.id, outputs: { artifact: "new" } } });
      const events = await store.claimDueEvents(new Date(), 10);
      expect(events.find((event) => event.eventType === "workspace.provisioning")?.payload).toMatchObject({
        workspace: { outputs: { artifact: "new" } },
      });
    } finally {
      await fixture.dispose();
    }
  },
);
