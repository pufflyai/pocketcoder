import { expect, test } from "bun:test";
import { leaseServiceFixture } from "./lease-service-fixture";
import { credentialedProfile } from "./managed-lease-fixture";

test("expired renewal rows close while one generation revoke obligation survives", async () => {
  const f = await leaseServiceFixture();
  try {
    const p = await credentialedProfile(f);
    p.config.revoke = true;
    await p.profile();
    const identity = await p.session();
    await f.store.managed.sessions.bind(identity, 0, {
      workspaceId: f.workspace.id,
      incarnationId: p.incarnationId,
      generation: 1,
    });
    f.issuer.controls.leaseLifetimeMs = 500;
    let current = await f.service.issueManaged(identity, f.workspace.id, 1, "runtime");
    const old = [];
    for (let i = 0; i < 3; i++) {
      old.push(current.lease.id);
      if (i === 2) f.issuer.controls.leaseLifetimeMs = 30000;
      const next = await f.service.renew(f.workspace.id, current.lease.id);
      await f.service.completeRenewal(f.workspace.id, current.lease.id, next.lease.id);
      current = next;
    }
    await Bun.sleep(600);
    for (const id of old) await f.service.expire(id);
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id)).map((row) => row.id)).toEqual([current.lease.id]);
    expect(f.issuer.controls.revokeCalls).toBe(0);
    expect(await f.issuer.resource(current.credential, identity.sessionId)).toBe(200);
    await f.service.revokeSession(f.workspace.id, identity.sessionId);
    await f.service.removed(f.workspace.id, identity.sessionId);
    expect(f.issuer.controls.revokeCalls).toBe(1);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});
