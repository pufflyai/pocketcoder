import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { reconcileSetupLeases } from "../lifecycle/setup-lease-reconciliation";
import { leaseServiceFixture } from "./lease-service-fixture";
import { credentialedProfile } from "./managed-lease-fixture";

// A stateless issuer returns different bytes on every call; the controller never re-mints an ID.
test("managed reconnects mint fresh, retain cleanup obligations, and need no binding expiry", async () => {
  const f = await leaseServiceFixture();
  try {
    const p = await credentialedProfile(f, { credentialPlacement: "shared" });
    const id = await p.session();
    await f.store.managed.sessions.bind(id, 0, {
      workspaceId: f.workspace.id,
      incarnationId: p.incarnationId,
      generation: 1,
    });
    const first = await f.service.issueManaged(id, f.workspace.id, 1, "runtime");
    const second = await f.service.replay(f.workspace.id, first.lease.id);
    expect(second.credential).not.toBe(first.credential);
    expect(second.lease.requestId).not.toBe(first.lease.requestId);
    expect((await f.store.getWorkspaceLease(first.lease.id))?.state).toBe("superseded");
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id)).length).toBe(2);
    expect(second.lease.managedAuthority).toMatchObject({
      ...id,
      profile: p.profileId,
      owner: "test-owner",
      generation: 1,
      slot: "runtime",
    });
    await f.service.revokeSession(f.workspace.id, id.sessionId);
    expect(f.issuer.controls.revokeCalls).toBe(0);
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id)).length).toBe(2);
    await f.service.removed(f.workspace.id, id.sessionId);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a mint arriving after close is dropped and cannot make the session ready", async () => {
  const f = await leaseServiceFixture();
  try {
    const p = await credentialedProfile(f);
    const id = await p.session();
    await f.store.managed.sessions.bind(id, 0, {
      workspaceId: f.workspace.id,
      incarnationId: p.incarnationId,
      generation: 1,
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.issuer.controls.beforeMint = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.service.issueManaged(id, f.workspace.id, 1, "runtime");
    await entered.promise;
    await f.store.managed.sessions.close(f.key.id, id.sessionId, new Date());
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect((await f.store.managed.sessions.get(f.key.id, id.sessionId)).state).toBe("closed");
    expect((await f.store.listWorkspaceLeases(f.workspace.id)).every((r) => r.state !== "delivered")).toBe(true);
  } finally {
    await f.close();
  }
});

test("renewal expiry preserves the new credential and close retries its generation notice", async () => {
  const f = await leaseServiceFixture();
  try {
    const p = await credentialedProfile(f);
    const {
      name,
      disabled: _disabled,
      templateVersion,
      ...profile
    } = await f.store.managed.profiles.get(f.key.id, p.profileId);
    await f.store.managed.profiles.reconcile(
      f.principal.id,
      { [name]: { ...profile, ...(templateVersion ? { templateVersion } : {}) } },
      { runtime: { ...p.config, revoke: true } },
    );
    const id = await p.session();
    await f.store.managed.sessions.bind(id, 0, {
      workspaceId: f.workspace.id,
      incarnationId: p.incarnationId,
      generation: 1,
    });
    f.issuer.controls.leaseLifetimeMs = 150;
    const first = await f.service.issueManaged(id, f.workspace.id, 1, "runtime");
    f.issuer.controls.leaseLifetimeMs = 30000;
    const next = await f.service.renew(f.workspace.id, first.lease.id);
    await f.service.completeRenewal(f.workspace.id, first.lease.id, next.lease.id);
    await Bun.sleep(160);
    await reconcileSetupLeases(f.store, f.service, {} as never);
    expect(await f.issuer.resource(next.credential, id.sessionId)).toBe(200);
    expect(f.issuer.controls.revokeCalls).toBe(0);
    await f.store.managed.sessions.close(f.key.id, id.sessionId, new Date());
    f.issuer.controls.reply = "outage";
    await expect(f.service.revokeSession(f.workspace.id, id.sessionId)).rejects.toThrow();
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id)).length).toBe(1);
    f.issuer.controls.reply = "valid";
    await f.service.revokeSession(f.workspace.id, id.sessionId);
    expect(f.issuer.controls.revokeCalls).toBe(1);
    expect(await f.issuer.resource(next.credential, id.sessionId)).toBe(401);
    await f.service.removed(f.workspace.id, id.sessionId);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["refused", "forbidden"] as const)(
  "issuer %s replies distinguish a refusal from an outage",
  async (reply) => {
    const f = await leaseServiceFixture();
    try {
      const p = await credentialedProfile(f);
      const id = await p.session();
      await f.store.managed.sessions.bind(id, 0, {
        workspaceId: f.workspace.id,
        incarnationId: p.incarnationId,
        generation: 1,
      });
      const accepted = await f.store.managed.requests.accept(
        f.key.id,
        id.sessionId,
        { requestId: randomUUID(), message: "first", attachments: [] },
        { count: 8, bytes: 1048576 },
      );
      f.issuer.controls.reply = reply;
      await expect(f.service.issueManaged(id, f.workspace.id, 1, "runtime")).rejects.toThrow();
      const failed = await f.store.managed.requests.get(f.key.id, id.sessionId, accepted.request.requestId);
      expect(failed.state).toBe(reply === "refused" ? "terminal" : "accepted");
      if (reply === "refused") {
        expect(failed.reasonCode).toBe("credentials_refused");
        f.issuer.controls.reply = "valid";
        await expect(f.service.issueManaged(id, f.workspace.id, 1, "runtime")).rejects.toThrow();
        expect(f.issuer.controls.mintCalls).toBe(1);
        await f.store.managed.requests.accept(
          f.key.id,
          id.sessionId,
          { requestId: randomUUID(), message: "retry on new work", attachments: [] },
          { count: 8, bytes: 1048576 },
        );
        const issued = await f.service.issueManaged(id, f.workspace.id, 1, "runtime");
        expect(await f.issuer.resource(issued.credential, id.sessionId)).toBe(200);
      }
    } finally {
      await f.close();
    }
  },
);

test("managed minting reads a rotated operator token file on the next call", async () => {
  const f = await leaseServiceFixture();
  try {
    const p = await credentialedProfile(f);
    const id = await p.session();
    await f.store.managed.sessions.bind(id, 0, {
      workspaceId: f.workspace.id,
      incarnationId: p.incarnationId,
      generation: 1,
    });
    const first = await f.service.issueManaged(id, f.workspace.id, 1, "runtime");
    const token = randomUUID();
    f.issuer.controls.authorization = `Bearer ${token}`;
    await Bun.write(p.config.tokenFile, token);
    const next = await f.service.replay(f.workspace.id, first.lease.id);
    expect(next.credential).not.toBe(first.credential);
    expect(await f.issuer.resource(next.credential, id.sessionId)).toBe(200);
  } finally {
    await f.close();
  }
});
