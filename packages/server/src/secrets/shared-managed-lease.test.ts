import { expect, test } from "bun:test";
import { leaseServiceFixture } from "./lease-service-fixture";
import { credentialedProfile } from "./managed-lease-fixture";

test("credentialed sessions sharing one workspace each hold and lose only their own leases", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    const profile = await credentialedProfile(f, { credentialPlacement: "shared" });
    const binding = { workspaceId: f.workspace.id, incarnationId: profile.incarnationId, generation: 1 };
    const closing = await profile.session();
    const sibling = await profile.session();
    const third = await profile.session();
    for (const identity of [closing, sibling, third]) await f.store.managed.sessions.bind(identity, 0, binding);
    const issue = (identity: typeof closing) => f.service.issueManaged(identity, f.workspace.id, 1, "runtime");
    const [first, second, last] = await Promise.all([issue(closing), issue(sibling), issue(third)]);
    expect(first.lease.managedAuthority?.sessionId).toBe(closing.sessionId);
    expect(second.lease.managedAuthority?.sessionId).toBe(sibling.sessionId);
    for (const issued of [first, second, last])
      expect(await f.issuer.resource(issued.credential, issued.lease.managedAuthority!.sessionId)).toBe(200);

    const current = await f.store.managed.sessions.get(f.key.id, closing.sessionId);
    await f.store.managed.sessions.appendObservation(closing, current.revision, "closed", null);
    await expect(f.service.renew(f.workspace.id, first.lease.id)).rejects.toThrow();
    const renewed = await f.service.renew(f.workspace.id, second.lease.id);
    await f.service.completeRenewal(f.workspace.id, second.lease.id, renewed.lease.id);

    await f.service.revokeSession(f.workspace.id, closing.sessionId);
    await f.service.removed(f.workspace.id, closing.sessionId);
    expect((await f.store.getWorkspaceLease(first.lease.id))?.state).toBe("revoked");
    expect(await f.issuer.resource(renewed.credential, sibling.sessionId)).toBe(200);
    expect(await f.issuer.resource(last.credential, third.sessionId)).toBe(200);
  } finally {
    await f.close();
  }
});

test("only sessions of the same opted-in profile join a credentialed workspace", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    const shared = await credentialedProfile(f, { credentialPlacement: "shared" });
    const binding = { workspaceId: f.workspace.id, incarnationId: shared.incarnationId, generation: 1 };
    await f.store.managed.sessions.bind(await shared.session(), 0, binding);
    const other = await shared.profile();
    await expect(f.store.managed.sessions.bind(await other.session(), 0, binding)).rejects.toThrow(
      "Session profile is unavailable",
    );
  } finally {
    await f.close();
  }
});

test("a session of a workload template receives a lease for its credential slot", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    const profile = await credentialedProfile(f, { credentialPlacement: "shared", workload: true });
    const identity = await profile.session();
    await f.store.managed.sessions.bind(identity, 0, {
      workspaceId: f.workspace.id,
      incarnationId: profile.incarnationId,
      generation: 1,
    });
    const issued = await f.service.issueManaged(identity, f.workspace.id, 1, "runtime");
    expect(issued.lease.managedAuthority).toMatchObject({ sessionId: identity.sessionId, slot: "runtime" });
    expect(await f.issuer.resource(issued.credential, issued.lease.managedAuthority!.sessionId)).toBe(200);
  } finally {
    await f.close();
  }
});
