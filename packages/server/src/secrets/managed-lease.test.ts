import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { leaseServiceFixture } from "./lease-service-fixture";
import { credentialedProfile } from "./managed-lease-fixture";

test("real issuer leases bind one exclusive session and generation with a finite immutable ceiling", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    const { template, config, scopeId, bindingId, profileId, incarnationId, authorityExpiresAt, session } =
      await credentialedProfile(f);
    const identity = await session();
    await f.store.managed.sessions.bind(identity, 0, { workspaceId: f.workspace.id, incarnationId, generation: 1 });
    const requestId = randomUUID();
    f.issuer.controls.reply = "lost";
    await expect(f.service.issueManaged(identity, f.workspace.id, 1, "runtime", requestId)).rejects.toThrow();
    f.issuer.controls.reply = "valid";
    const issued = await f.service.issueManaged(identity, f.workspace.id, 1, "runtime", requestId);
    expect(issued.lease.managedAuthority).toMatchObject({ ...identity, generation: 1, incarnationId, bindingId });
    expect(issued.lease.requestExpiresAt.getTime()).toBeLessThanOrEqual(authorityExpiresAt.getTime());
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(200);
    await expect(f.service.issueManaged(identity, f.workspace.id, 2, "runtime", randomUUID())).rejects.toThrow();
    await expect(f.service.issueManaged(identity, f.workspace.id, 1, "other", randomUUID())).rejects.toThrow();
    await expect(f.service.issueManaged(identity, f.workspace.id, 1, "extra", randomUUID())).rejects.toThrow();
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const renewal = await f.service.renew(f.workspace.id, issued.lease.id, randomUUID());
    expect(renewal.lease.secretVersionId).toBe(config.id);
    await f.service.completeRenewal(f.workspace.id, issued.lease.id, renewal.lease.id);
    const siblingId = randomUUID();
    await f.store.managed.sessions.create(f.key.id, { sessionId: siblingId, profileId, profileRevision: 1 });
    await expect(
      f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: siblingId }, 0, {
        workspaceId: f.workspace.id,
        incarnationId,
        generation: 1,
      }),
    ).rejects.toThrow();
    const { effectiveAt: _, ...budget } = await f.store.managed.budgets.readPolicy(f.key.id, scopeId);
    await f.store.managed.budgets.writePolicy(
      f.key.id,
      { ...budget, revision: 2, limits: { ...budget.limits, maxActiveWorkspaces: 1 } },
      1,
    );
    const additional = [];
    for (let index = 0; index < 4; index++) {
      const nextSession = index === 0 ? siblingId : randomUUID();
      if (index > 0)
        await f.store.managed.sessions.create(f.key.id, { sessionId: nextSession, profileId, profileRevision: 1 });
      const nextWorkspace = await insertTestWorkspace(
        { ...f, parsed: template.parsed ?? f.parsed, template: template.row },
        randomUUID(),
      );
      const placement = {
        principalId: f.principal.id,
        sessionId: nextSession,
        workspaceId: nextWorkspace.id,
        generation: 1,
      };
      additional.push(placement);
      await expect(f.store.managed.capacity.place(placement)).rejects.toThrow("budget");
    }
    expect((await f.store.managed.budgets.usage(f.key.id, scopeId)).activeWorkspaces).toBe(1);
    await f.store.managed.budgets.writePolicy(f.key.id, { ...budget, revision: 3 }, 2);
    for (const placement of additional) await f.store.managed.capacity.place(placement);
    expect((await f.store.managed.budgets.usage(f.key.id, scopeId)).activeWorkspaces).toBe(5);
    await expect(f.service.issue(f.workspace.id, "runtime", "runtime-issuer")).rejects.toThrow();
    const current = await f.store.managed.sessions.get(f.key.id, identity.sessionId);
    await f.store.managed.sessions.appendObservation(identity, current.revision, "closed", null);
    await expect(f.service.renew(f.workspace.id, renewal.lease.id, randomUUID())).rejects.toThrow();
    f.issuer.controls.reply = "outage";
    await expect(f.service.revokeWorkspace(f.workspace.id)).rejects.toThrow();
    expect((await f.store.getWorkspaceLease(renewal.lease.id))?.state).toBe("revoking");
    f.issuer.controls.reply = "valid";
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(401);
  } finally {
    await f.close();
  }
});
