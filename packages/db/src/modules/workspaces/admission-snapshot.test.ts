import { expect, test } from "bun:test";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

test.each(["memory", "disk"] as const)(
  "admission snapshot reads fresh heads, backlog and capacity (%s)",
  async (mode) => {
    const fixture = await createPGliteFixture("pc-admission-snapshot", mode);
    try {
      const first = await insertTestWorkspace(fixture, "first");
      const second = await insertTestWorkspace(fixture, "second");
      const third = await insertTestWorkspace(fixture, "third");
      const expiresAt = new Date("2030-01-02T03:04:05.006Z");
      const registrationDigest = new Uint8Array([0, 255, 92, 34]);
      await fixture.store.updateWorkspace(
        first.id,
        { registrationDigest, registrationExpiresAt: expiresAt },
        new Date(),
      );
      let snapshot = await fixture.store.readAdmissionSnapshot();
      expect(snapshot.queued.map((row) => row.id)).toEqual([first.id]);
      expect(snapshot.queued[0]).toMatchObject({
        createdAt: first.createdAt,
        registrationDigest,
        registrationExpiresAt: expiresAt,
        terminalAt: null,
      });
      expect(snapshot.queuedCount).toBe(3);
      expect(snapshot.counts).toEqual({ global: 0, byPrincipal: {}, byTemplate: {} });
      for (const row of [first, second, third]) {
        await fixture.store.transition(row.id, { from: ["queued"], to: "provisioning", at: new Date() });
        snapshot = await fixture.store.readAdmissionSnapshot();
        const active = [first, second, third].indexOf(row) + 1;
        expect(snapshot.queuedCount).toBe(3 - active);
        expect(snapshot.counts).toEqual({
          global: active,
          byPrincipal: { [fixture.principal.id]: active },
          byTemplate: { [fixture.template.name]: active },
        });
      }
      expect(snapshot.queued).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  },
);

test.each(["memory", "disk"] as const)(
  "snapshot capacity groups principals and templates independently (%s)",
  async (mode) => {
    const fixture = await createPGliteFixture("pc-snapshot-groups", mode);
    try {
      const otherPrincipal = await fixture.store.createPrincipal("other", ["admin"], ["*"]);
      const parsed = parseTemplateManifest({
        ...fixture.parsed.manifest,
        metadata: { name: "other-template" },
      });
      const { row: template } = await fixture.store.upsertTemplate({
        name: parsed.manifest.metadata.name,
        version: parsed.manifest.spec.version,
        digest: parsed.digest,
        description: null,
        spec: parsed.manifest.spec,
      });
      const first = await insertTestWorkspace(fixture, "first");
      const backlog = await insertTestWorkspace(fixture, "backlog");
      const otherTemplate = await insertTestWorkspace({ ...fixture, parsed, template }, "other-template");
      const otherOwner = await insertTestWorkspace({ ...fixture, principal: otherPrincipal }, "other-owner");
      const queued = await fixture.store.readAdmissionSnapshot();
      expect(queued.queued.map((row) => row.id)).toEqual([first.id, otherOwner.id]);
      expect(queued.queuedCount).toBe(4);
      for (const row of [first, otherTemplate, otherOwner]) {
        await fixture.store.transition(row.id, { from: ["queued"], to: "provisioning", at: new Date() });
      }
      const snapshot = await fixture.store.readAdmissionSnapshot();
      expect(snapshot.queued.map((row) => row.id)).toEqual([backlog.id]);
      expect(snapshot.queuedCount).toBe(1);
      expect(snapshot.counts).toEqual({
        global: 3,
        byPrincipal: { [fixture.principal.id]: 2, [otherPrincipal.id]: 1 },
        byTemplate: { [fixture.template.name]: 2, [template.name]: 1 },
      });
    } finally {
      await fixture.dispose();
    }
  },
);
