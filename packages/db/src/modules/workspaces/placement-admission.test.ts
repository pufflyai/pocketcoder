import { expect, test } from "bun:test";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

test("counts placement across template versions and atomically caps concurrent claims", async () => {
  const f = await createPGliteFixture("placement-admission");
  try {
    const parsed = parseTemplateManifest({
      ...f.parsed.manifest,
      spec: { ...f.parsed.manifest.spec, placement: "engine" },
    });
    const { row: template } = await f.store.upsertTemplate({
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.spec.version,
      digest: parsed.digest,
      description: null,
      spec: parsed.manifest.spec,
    });
    const rows = await Promise.all(
      ["a", "b", "c"].map((name) => insertTestWorkspace({ ...f, parsed, template }, name)),
    );
    const limits = {
      globalActiveWorkspaces: 10,
      perPrincipalActiveWorkspaces: 10,
      perTemplateActiveWorkspaces: {},
      perPlacementActiveWorkspaces: { engine: 2 },
    };
    const claim = (workspaceId: string) =>
      f.store.claimWorkspaceAdmission({
        workspaceId,
        at: new Date(),
        registrationDigest: new Uint8Array(32),
        registrationExpiresAt: new Date(Date.now() + 60_000),
        limits,
      });
    const claims = await Promise.all(rows.map((row) => claim(row.id)));
    expect(claims.filter(Boolean)).toHaveLength(2);
    expect((await f.store.countActive()).byPlacement).toEqual({ engine: 2 });
    expect((await f.store.readAdmissionSnapshot()).counts.byPlacement).toEqual({ engine: 2 });
  } finally {
    await f.dispose();
  }
});
