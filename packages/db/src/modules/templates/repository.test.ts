import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createPGliteFixture } from "../../test-fixtures";

test.each(["active", "available", "retired"] as const)(
  "reads a %s historical template without inventing a harness or changing stored content",
  async (status) => {
    const f = await createPGliteFixture("pc-template-history");
    try {
      const spec = { ...f.parsed.manifest.spec, agent: { kind: "agentapi" } };
      Reflect.deleteProperty(spec, "harness");
      const { templates } = f.context.tables;
      await f.context.db.update(templates).set({ spec, status }).where(eq(templates.id, f.template.id));

      expect(await f.store.listTemplates(null)).toMatchObject([{ digest: f.template.digest, status }]);
      const template = await f.store.getTemplate(f.template.name, f.template.version);
      expect(template?.spec.harness).toBeUndefined();
      const [stored] = await f.context.db.select().from(templates).where(eq(templates.id, f.template.id));
      expect(stored?.spec).toEqual(spec);
      expect(stored?.digest).toBe(f.template.digest);
    } finally {
      await f.dispose();
    }
  },
);

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
