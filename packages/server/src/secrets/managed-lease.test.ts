import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { leaseServiceFixture } from "./lease-service-fixture";

test("real issuer leases bind one exclusive session and generation with a finite immutable ceiling", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const source = parseTemplateManifest({
      ...f.parsed.manifest,
      metadata: { name: "managed-lease" },
      spec: { ...f.parsed.manifest.spec, env: { TOKEN_FILE: "secretRef:runtime" } },
    });
    const { row: template } = await f.store.upsertTemplate({
      name: "managed-lease",
      version: source.manifest.spec.version,
      digest: source.digest,
      description: null,
      spec: source.manifest.spec,
    });
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ templateId: template.id, templateDigest: source.digest, templateSnapshot: snapshotOf(source) })
      .where(eq(f.context.tables.workspaces.id, f.workspace.id));
    const config = await f.vault.resolve("runtime", "runtime-issuer");
    const scopeId = randomUUID(),
      bindingId = randomUUID(),
      sessionId = randomUUID(),
      profileId = randomUUID();
    const authorityExpiresAt = new Date(Date.now() + 30_000);
    await f.store.managed.authority.registerScope(f.key.id, scopeId, f.principal.id, true);
    await f.store.managed.authority.registerCredential(f.key.id, {
      bindingId,
      principalId: f.principal.id,
      secretName: "runtime",
      secretVersionId: config.id,
      slots: ["runtime", "extra"],
      authorityExpiresAt,
    });
    const profile = {
      profileId,
      revision: 1,
      isolationScopeId: randomUUID(),
      budgetScopeIds: [scopeId],
      templateDigest: source.digest,
      allowedModels: ["local/model"],
      credentialBindingId: bindingId,
    };
    await f.store.managed.authority.provisionProfile(f.key.id, f.principal.id, profile);
    await f.store.managed.sessions.create(f.key.id, { sessionId, profileId, profileRevision: 1 });
    const incarnationId = randomUUID();
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        runtimeRegistration: { incarnationId, containerIdentity: incarnationId, profile: "service", producer: null },
      })
      .where(eq(f.context.tables.workspaces.id, f.workspace.id));
    await f.store.managed.budgets.writePolicy(
      f.key.id,
      {
        scopeId,
        revision: 1,
        period: "utc_day",
        limits: {
          inputTokens: 100,
          outputTokens: 100,
          workspaceStarts: 10,
          maxActiveWorkspaces: 5,
          maxInFlightModelRequests: 5,
          modelRequestsPerMinute: 10,
          modelRequestsPerMinutePerWorkspace: 10,
          maxRunningRequestsPerSession: 1,
          maxChatProcessesPerWorkspace: 5,
          defaultOutputTokens: 20,
          maxOutputTokensPerInvocation: 40,
        },
        modelLimits: [],
      },
      null,
    );
    const identity = { principalId: f.principal.id, sessionId };
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
    await expect(f.service.issue(f.workspace.id, "runtime", "runtime-issuer")).rejects.toThrow();
    const current = await f.store.managed.sessions.get(f.key.id, sessionId);
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
