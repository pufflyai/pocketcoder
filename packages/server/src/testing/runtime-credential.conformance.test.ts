import { expect, test } from "bun:test";
import { TemplateManifestSchema } from "@pstdio/pocketcoder-contracts";
import { waitFor } from "./e2e-test-support";
import { runtimeCredentialLiveFixture } from "./runtime-credential-live-fixture";

test.each(["docker", "kubernetes"] as const)(
  "%s agent uses renewed HTTPS authority and loses it after cancellation",
  async (provider) => {
    const f = await runtimeCredentialLiveFixture(provider);
    try {
      const id = await f.create();
      await f.ready(id);
      const initial = await f.request(id);
      expect(initial.status).toBe(200);
      const renewed = await waitFor(
        async () => {
          const reply = await f.request(id);
          return reply.credential !== initial.credential ? reply : null;
        },
        15_000,
        "runtime renewal",
      );
      expect(renewed.status).toBe(200);
      await waitFor(
        async () => (await f.issuer.resource(initial.credential, id)) === 401,
        5000,
        "old lease revocation",
      );
      const leases = await f.store.listWorkspaceLeases(id);
      expect(leases.length).toBeGreaterThanOrEqual(2);
      for (const lease of leases) {
        expect(lease.purpose).toBe("runtime-issuer");
        expect(lease.requestExpiresAt.getTime() - lease.createdAt.getTime()).toBeLessThanOrEqual(300_000);
      }
      const row = await f.store.getWorkspace(id);
      if (!row) throw new Error("Missing workspace");
      f.issuer.controls.reply = "outage";
      await f.built.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
      expect((await f.store.getWorkspace(id))?.state).toBe("terminating");
      expect((await f.store.listPendingWorkspaceLeases(id)).length).toBeGreaterThan(0);
      f.issuer.controls.reply = "valid";
      await f.built.scheduler.finalize(row, "canceled", "canceled_by_caller", new Date());
      expect((await f.store.getWorkspace(id))?.state).toBe("canceled");
      expect(await f.issuer.resource(renewed.credential, id)).toBe(401);
      expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
      expect(JSON.stringify(await f.store.readLogs(id, 0, 100))).not.toContain(f.issuer.authorization);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("Docker preserve revokes authority, restore mints fresh authority, and purge closes it", async () => {
  const f = await runtimeCredentialLiveFixture("docker", true);
  try {
    const id = await f.create();
    await f.ready(id);
    const before = await f.request(id);
    expect(before.status).toBe(200);
    f.issuer.controls.reply = "outage";
    const preserved = await f.client.workspaces.preserve(id, {}, crypto.randomUUID());
    await f.built.persistence.drain();
    expect(await f.store.getOperation(preserved.operation.id)).toMatchObject({ state: "pending", completedAt: null });
    expect((await f.store.getCheckpoint(preserved.checkpoint.id))?.state).toBe("creating");
    expect(await f.issuer.resource(before.credential, id)).toBe(200);
    f.issuer.controls.reply = "valid";
    await f.built.persistence.retryPreserves();
    await waitFor(
      async () => (await f.store.getOperation(preserved.operation.id))?.state === "succeeded",
      20_000,
      "runtime preserve",
    );
    expect((await f.store.getWorkspace(id))?.state).toBe("preserved");
    expect(await f.issuer.resource(before.credential, id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
    const resumed = await f.client.checkpoints.restore(
      preserved.checkpoint.id,
      { external_id: crypto.randomUUID() },
      crypto.randomUUID(),
    );
    const freshId = resumed.workspace.id;
    f.track(freshId);
    await f.built.scheduler.tick();
    await f.ready(freshId);
    const fresh = await f.request(freshId);
    expect(fresh.status).toBe(200);
    expect(fresh.credential).not.toBe(before.credential);
    expect(await f.issuer.resource(fresh.credential, id)).toBe(401);
    const purged = await f.client.workspaces.purge(freshId, crypto.randomUUID());
    await waitFor(async () => (await f.store.getOperation(purged.id))?.state === "succeeded", 15_000, "runtime purge");
    expect(await f.issuer.resource(fresh.credential, freshId)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(freshId)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("Docker cannot fall back to a mounted file secret when a runtime issuer is missing", async () => {
  const f = await runtimeCredentialLiveFixture("docker", false, false);
  try {
    const id = await f.create();
    expect((await f.store.getWorkspace(id))?.providerRef).toBeNull();
    expect(f.issuer.controls.mintCalls).toBe(0);
  } finally {
    await f.close();
  }
}, 60_000);

test("Docker cancellation settles a pending preserve and allows purge after issuer recovery", async () => {
  const f = await runtimeCredentialLiveFixture("docker", true);
  try {
    const id = await f.create();
    await f.ready(id);
    const before = await f.request(id);
    f.issuer.controls.reply = "outage";
    const preserve = await f.client.workspaces.preserve(id, {}, crypto.randomUUID());
    await f.built.persistence.drain();
    await f.client.workspaces.cancel(id);
    await f.built.scheduler.drain();
    expect((await f.store.getWorkspace(id))?.state).toBe("terminating");
    expect((await f.store.getOperation(preserve.operation.id))?.state).toBe("pending");
    f.issuer.controls.reply = "valid";
    const current = await f.store.getWorkspace(id);
    if (!current) throw new Error("Missing workspace");
    await f.built.scheduler.finalize(current, "canceled", "canceled_by_caller", new Date());
    await f.built.persistence.retryPreserves();
    await f.built.persistence.drain();
    expect((await f.store.getOperation(preserve.operation.id))?.state).toBe("failed");
    expect((await f.store.getCheckpoint(preserve.checkpoint.id))?.state).toBe("failed");
    expect(await f.issuer.resource(before.credential, id)).toBe(401);
    const purge = await f.client.workspaces.purge(id, crypto.randomUUID());
    await waitFor(
      async () => (await f.store.getOperation(purge.id))?.state === "succeeded",
      15_000,
      "canceled preserve purge",
    );
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["docker", "kubernetes"] as const)(
  "%s failed agent launch revokes runtime authority",
  async (provider) => {
    const f = await runtimeCredentialLiveFixture(provider);
    try {
      await f.client.templates.publish(
        TemplateManifestSchema.parse({
          ...f.manifest,
          spec: {
            ...f.manifest.spec,
            version: "1.0.1",
            harness: { command: ["bun", "-e", "process.exit(42)"], env: {} },
          },
        }),
      );
      const id = await f.create();
      await waitFor(async () => (await f.store.getWorkspace(id))?.state === "failed", 30_000, "failed agent cleanup");
      expect(f.issuer.controls.mintCalls).toBe(1);
      expect(await f.issuer.resource(f.issuer.controls.captured, id)).toBe(401);
      expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
    } finally {
      await f.close();
    }
  },
  60_000,
);
