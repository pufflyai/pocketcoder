import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { insertTestWorkspace } from "../../test-fixtures";
import { managedFixture, policy, provision } from "../managed/fixture.test";
import { sessionWorkFixture } from "../sessions/work-fixture.test";

test("concurrent physical admission reserves the last start before storage preparation and never-launched cleanup releases slots", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const budget = policy(f.scopeId, 2);
    budget.limits.workspaceStarts = 1;
    await f.store.managed.budgets.writePolicy(f.keyId, budget, 1);
    const ids = [f.sessionId, randomUUID()];
    const a = await insertTestWorkspace(f, randomUUID()),
      b = await insertTestWorkspace(f, randomUUID());
    await f.store.managed.sessions.create(f.keyId, {
      sessionId: ids[1]!,
      profileId: f.profile.profileId,
      profileRevision: 1,
    });
    for (const [index, workspace] of [a, b].entries())
      await f.store.managed.capacity.place({
        principalId: f.principal.id,
        sessionId: ids[index]!,
        workspaceId: workspace.id,
        generation: 1,
      });
    const results = await Promise.all(
      [a, b].map((workspace) =>
        f.store.claimWorkspaceAdmission({
          workspaceId: workspace.id,
          at: new Date(),
          registrationDigest: new Uint8Array([1]),
          registrationExpiresAt: new Date(Date.now() + 60000),
          limits: { ...DEFAULT_LIMITS, globalActiveWorkspaces: 10, perPrincipalActiveWorkspaces: 10 },
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).workspaceStarts).toBe(0);
    const accepted = results.find(Boolean)!;
    const pending = accepted.id === a.id ? b : a;
    expect((await f.store.getWorkspace(pending.id))?.launchAttempts).toBe(0);
    await f.store.managed.capacity.notSubmitted(accepted.id, 1, new Date());
    await f.store.transition(accepted.id, { from: ["provisioning"], to: "queued", at: new Date() });
    await f.store.transition(accepted.id, { from: ["queued"], to: "canceled", at: new Date() });
    await f.store.managed.capacity.releaseUnlaunched(accepted.id, new Date());
    await f.store.transition(pending.id, { from: ["queued"], to: "expired", at: new Date(), reason: "queue_timeout" });
    await f.store.managed.capacity.reconcile(new Date());
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      activeWorkspaces: 0,
      workspaceStarts: 0,
    });
  } finally {
    await f.dispose();
  }
});

test("real session process exits free only their own slots and physical cleanup never refunds uncertain model use", async () => {
  const f = await sessionWorkFixture();
  const children: Bun.Subprocess[] = [];
  try {
    const sessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sessionId = i === 0 ? f.sessionId : randomUUID();
      if (i)
        await f.store.managed.sessions.create(f.keyId, {
          sessionId,
          profileId: f.profile.profileId,
          profileRevision: 1,
        });
      await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
        workspaceId: f.id,
        incarnationId: f.runtime.incarnationId,
        generation: 1,
      });
      children.push(
        Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" }),
      );
      sessions.push(sessionId);
    }
    const sixth = randomUUID();
    await f.store.managed.sessions.create(f.keyId, {
      sessionId: sixth,
      profileId: f.profile.profileId,
      profileRevision: 1,
    });
    await expect(
      f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: sixth }, 0, {
        workspaceId: f.id,
        incarnationId: f.runtime.incarnationId,
        generation: 1,
      }),
    ).rejects.toThrow("budget");
    children[0]!.kill("SIGTERM");
    await children[0]!.exited;
    await f.store.managed.capacity.processStopped(
      { principalId: f.principal.id, sessionId: f.sessionId, workspaceId: f.id, generation: 1 },
      f.runtime.incarnationId,
      new Date(),
    );
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: sixth }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const invocation = {
      principalId: f.principal.id,
      sessionId: sessions[1]!,
      requestId: randomUUID(),
      invocationId: randomUUID(),
    };
    await f.store.managed.budgets.reserve({
      identity: invocation,
      workspaceId: f.id,
      model: "fixture/model",
      requestDigest: `sha256:${"a".repeat(64)}`,
      countEvidenceRef: "fixture-count",
      inputTokens: 10,
      requestedOutputTokens: 20,
    });
    await f.store.managed.budgets.claimSend(invocation);
    await f.store.managed.budgets.retainUncertain(invocation);
    await f.store.managed.capacity.cleanupPending(f.id, 0, new Date());
    expect((await f.store.managed.budgets.usage(f.keyId, f.scopeId)).activeWorkspaces).toBe(1);
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exited));
    await f.store.managed.capacity.cleanup(f.id, 0, "provider_fenced", new Date());
    expect(await f.store.managed.budgets.usage(f.keyId, f.scopeId)).toMatchObject({
      activeWorkspaces: 0,
      heldInputTokens: 10,
      heldOutputTokens: 20,
      unresolvedInvocations: 1,
    });
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await f.dispose();
  }
});
