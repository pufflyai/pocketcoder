import { expect, test } from "bun:test";
import { createPGliteFixture } from "../../test-fixtures";

// Journal records replay at every PostgreSQL start, so a refused retirement must leave none.
test("retiring an unknown version journals nothing", async () => {
  const f = await createPGliteFixture("pc-template-retire", "disk");
  try {
    const actor = crypto.randomUUID();
    await f.store.insertMachineKey({
      id: actor,
      principalId: f.principal.id,
      secretDigest: new Uint8Array(32),
      scopes: [],
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    const before = f.context.journal?.records().length;
    await expect(f.store.retireTemplate(actor, f.template.name, "9.9.9")).rejects.toMatchObject({
      code: "template.version_not_found",
    });
    expect(f.context.journal?.records().length).toBe(before);
    await f.store.retireTemplate(actor, f.template.name, f.template.version);
    expect(f.context.journal?.records().at(-1)?.event).toMatchObject({ kind: "template_retired" });
  } finally {
    await f.dispose();
  }
});
