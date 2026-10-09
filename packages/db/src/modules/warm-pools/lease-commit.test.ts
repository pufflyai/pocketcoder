import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

async function readyRuntime(fixture: Awaited<ReturnType<typeof createPGliteFixture>>, name = "lease") {
  const at = new Date();
  const { template } = fixture;
  const runtime = {
    id: randomUUID(),
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateDigest: template.digest,
    driverKind: "docker",
    eligibilityFingerprint: "sha256:eligible",
    state: "ready" as const,
    providerRef: { kind: "docker", id: `warm-provider-'\\-${name}` },
    enrollmentDigest: null,
    enrollmentExpiresAt: null,
    workspaceId: null,
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    leasedAt: null,
    failureCode: null,
  };
  await fixture.store.insertWarmPoolRuntime(runtime);
  const workspace = await insertTestWorkspace(fixture, name);
  return {
    runtime,
    claim: {
      workspace,
      driverKind: "docker",
      eligibilityFingerprint: runtime.eligibilityFingerprint,
      registrationDigest: new Uint8Array([0, 255, 92, 34]),
      registrationExpiresAt: new Date(at.getTime() + 60000),
      at,
    },
  };
}

test.each(["memory", "disk"] as const)("warm claim commits the lease and admission together (%s)", async (mode) => {
  const fixture = await createPGliteFixture("warm-lease-commit", mode);
  try {
    const { runtime, claim } = await readyRuntime(fixture);
    const result = await fixture.store.claimWarmPoolRuntime(claim);
    expect(result).toMatchObject({
      runtime: { id: runtime.id, state: "leased", workspaceId: claim.workspace.id, leasedAt: claim.at },
      workspace: {
        state: "provisioning",
        provisioningMode: "warm",
        providerRef: runtime.providerRef,
        registrationDigest: claim.registrationDigest,
        registrationExpiresAt: claim.registrationExpiresAt,
      },
    });
    expect(await fixture.store.getWarmPoolRuntime(runtime.id)).toMatchObject({
      state: "leased",
      workspaceId: claim.workspace.id,
    });
    expect(await fixture.store.listStateHistory(claim.workspace.id)).toHaveLength(2);
    expect(
      (await fixture.store.claimDueEvents(new Date(), 10)).filter((e) => e.eventType === "workspace.provisioning"),
    ).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

test("warm admissions reuse the native prepared statement while binding fresh workspace values", async () => {
  const fixture = await createPGliteFixture("warm-prepared-lease");
  const client = fixture.context.client;
  const execute = client.execProtocolRawSync.bind(client);
  let preparations = 0;
  client.execProtocolRawSync = (message) => {
    if (message[0] === 80 && new TextDecoder().decode(message).includes('with "locked_workspace"')) preparations += 1;
    return execute(message);
  };
  try {
    for (const name of ["first", "second"]) {
      const { runtime, claim } = await readyRuntime(fixture, name);
      expect(await fixture.store.claimWarmPoolRuntime(claim)).toMatchObject({
        runtime: { id: runtime.id, state: "leased", workspaceId: claim.workspace.id },
        workspace: { id: claim.workspace.id, registrationDigest: claim.registrationDigest },
      });
    }
    expect(preparations).toBe(1);
    expect(
      await fixture.query("select generic_plans, custom_plans from pg_prepared_statements where statement like $1", [
        'with "locked_workspace"%',
      ]),
    ).toEqual([{ generic_plans: 2, custom_plans: 0 }]);
    expect(await fixture.query("show plan_cache_mode")).toEqual([{ plan_cache_mode: "auto" }]);
  } finally {
    client.execProtocolRawSync = execute;
    await fixture.dispose();
  }
});

test("a warm lease waits for an unrelated transaction to roll back before committing", async () => {
  const fixture = await createPGliteFixture("warm-transaction-exclusion");
  const { runtime, claim } = await readyRuntime(fixture);
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transaction = fixture.context.db.transaction(async (tx) => {
    await tx.execute(sql`select 1`);
    opened.resolve();
    await release.promise;
    throw new Error("unrelated rollback");
  });
  const rollback = transaction.catch((error) => {
    expect(error.message).toBe("unrelated rollback");
  });
  await opened.promise;
  let committed = false;
  const pending = fixture.store.claimWarmPoolRuntime(claim).then((result) => {
    committed = true;
    return result;
  });
  try {
    // Let the actual database claim run while the other transaction remains open.
    await Bun.sleep(30);
    expect(committed).toBe(false);
    release.resolve();
    await rollback;
    expect(await pending).toMatchObject({ runtime: { id: runtime.id, state: "leased" } });
    expect(await fixture.store.getWarmPoolRuntime(runtime.id)).toMatchObject({
      state: "leased",
      workspaceId: claim.workspace.id,
    });
    expect((await fixture.store.getWorkspace(claim.workspace.id))?.state).toBe("provisioning");
  } finally {
    release.resolve();
    await Promise.allSettled([rollback, pending]);
    await fixture.dispose();
  }
});

test.each(["memory", "disk"] as const)(
  "failed warm event publication rolls back the entire lease (%s)",
  async (mode) => {
    const fixture = await createPGliteFixture("warm-lease-rollback", mode);
    try {
      const { runtime, claim } = await readyRuntime(fixture);
      await fixture.query(
        `ALTER TABLE "${fixture.schema}".event_outbox ADD CONSTRAINT reject_provisioning CHECK (event_type <> 'workspace.provisioning')`,
      );
      await expect(fixture.store.claimWarmPoolRuntime(claim)).rejects.toThrow();
      expect(await fixture.query("show plan_cache_mode")).toEqual([{ plan_cache_mode: "auto" }]);
      expect(await fixture.store.getWarmPoolRuntime(runtime.id)).toMatchObject({ state: "ready", workspaceId: null });
      expect((await fixture.store.getWorkspace(claim.workspace.id))?.state).toBe("queued");
      expect(await fixture.store.listStateHistory(claim.workspace.id)).toHaveLength(1);
      expect(await fixture.store.claimDueEvents(new Date(), 10)).toHaveLength(1);
      await fixture.query(`ALTER TABLE "${fixture.schema}".event_outbox DROP CONSTRAINT reject_provisioning`);
      expect(await fixture.store.claimWarmPoolRuntime(claim)).toMatchObject({
        runtime: { id: runtime.id, state: "leased", workspaceId: claim.workspace.id },
        workspace: { id: claim.workspace.id, state: "provisioning" },
      });
    } finally {
      await fixture.dispose();
    }
  },
);
