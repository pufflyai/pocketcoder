import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { managedFixture, provision } from "./fixture.test";

test("a missing pinned template cannot reserve capacity and a corrected profile recovers the same session", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const { name, templateDigest: _digest, ...config } = f.profile;
    const result = await f.store.managed.profiles.reconcile(
      f.principal.id,
      {
        [name]: { ...config, templateVersion: "9.9.9" },
      },
      {},
    );
    expect(result).toMatchObject({ unavailableProfiles: [name] });
    expect(await f.store.managed.profiles.get(f.keyId, name)).toMatchObject({
      templateVersion: "9.9.9",
      disabled: true,
    });
    const id = { principalId: f.principal.id, sessionId: f.sessionId };
    await expect(f.store.managed.capacity.reserve(id, 1, new Date())).rejects.toMatchObject({
      code: "template.not_found",
    });
    expect(await f.context.db.select().from(f.context.tables.managedCapacity)).toEqual([]);
    const table = f.context.tables.managedSessions;
    const [saved] = await f.context.db.select().from(table).where(eq(table.sessionId, f.sessionId));
    expect(saved?.placement).toBeNull();
    await f.store.managed.profiles.reconcile(
      f.principal.id,
      {
        [name]: { ...config, templateVersion: f.template.version },
      },
      {},
    );
    expect(await f.store.managed.capacity.reserve(id, 1, new Date())).toMatchObject({
      generation: 1,
      templateDigest: f.template.digest,
      templateVersion: f.template.version,
    });
  } finally {
    await f.dispose();
  }
});

test("a retired pin is unavailable but an older available pin still works", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const { name, templateDigest: _digest, ...config } = f.profile;
    const reconcile = () =>
      f.store.managed.profiles.reconcile(
        f.principal.id,
        { [name]: { ...config, templateVersion: f.template.version } },
        {},
      );
    await f.context.db
      .update(f.context.tables.templates)
      .set({ status: "available" })
      .where(eq(f.context.tables.templates.id, f.template.id));
    expect((await reconcile()).unavailableProfiles).toEqual([]);
    await f.store.retireTemplate(f.keyId, f.template.name, f.template.version);
    expect((await reconcile()).unavailableProfiles).toEqual([name]);
    await expect(
      f.store.managed.capacity.reserve({ principalId: f.principal.id, sessionId: f.sessionId }, 1, new Date()),
    ).rejects.toMatchObject({ code: "template.not_found" });
    expect(await f.context.db.select().from(f.context.tables.managedCapacity)).toEqual([]);
  } finally {
    await f.dispose();
  }
});
