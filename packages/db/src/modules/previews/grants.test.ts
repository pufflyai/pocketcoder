import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseStore } from "../../store";
import { createPGliteFixture } from "../../test-fixtures";

test.each(["memory", "disk"] as const)(
  "%s preview grants retain identity, expiry and revocation across restart",
  async (mode) => {
    const f = await createPGliteFixture("preview-grants", mode);
    let store = f.store;
    const at = new Date();
    const row = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      incarnationId: "original",
      principalId: f.principal.id,
      keyId: randomUUID(),
      subject: "opaque-U",
      accessRevision: "r1",
      previews: ["web"],
      createdAt: at,
      expiresAt: new Date(at.getTime() + 1000),
      ceilingAt: new Date(at.getTime() + 60000),
      revokedAt: null,
    };
    try {
      const expired = {
        ...row,
        id: randomUUID(),
        createdAt: new Date(at.getTime() - 4000),
        expiresAt: new Date(at.getTime() - 1000),
      };
      await store.previewGrants.create(expired);
      expect(
        await store.previewGrants.renew(expired.id, "r1", row.ceilingAt, new Date(at.getTime() - 2000)),
      ).toBeNull();
      expect(await store.previewGrants.create(row)).toEqual(row);
      expect(await store.previewGrants.create({ ...row, subject: "changed" })).toBeNull();
      expect(await store.previewGrants.renew(row.id, "r2", row.ceilingAt, at)).toBeNull();
      expect(await store.previewGrants.renew(row.id, "r1", row.ceilingAt, row.expiresAt)).toBeNull();
      if (mode === "disk") {
        if (!f.directory) throw new Error("Disk directory missing");
        await store.close();
        store = await DatabaseStore.openPGlite(f.directory);
      }
      expect(await store.previewGrants.get(row.id)).toEqual(row);
      await store.previewGrants.revoke(row.id, at);
      if (mode === "disk") {
        await store.close();
        store = await DatabaseStore.openPGlite(f.directory);
      }
      expect((await store.previewGrants.get(row.id))?.revokedAt).toEqual(at);
      expect(await store.previewGrants.renew(row.id, "r1", row.ceilingAt, at)).toBeNull();
    } finally {
      if (store !== f.store) await store.close();
      await f.dispose();
    }
  },
);
