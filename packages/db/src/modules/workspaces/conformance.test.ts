import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, EventEnvelopeSchema, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { Store, WarmPoolClaim, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { createPGliteFixture, insertTestWorkspace, workspaceOf } from "../../test-fixtures";

function findLease(claims: Awaited<ReturnType<Store["claimWarmPoolRuntime"]>>[]) {
  for (const result of claims) {
    if (result && !("kind" in result)) return result;
  }
}

async function insertReadyRuntime(fixture: Awaited<ReturnType<typeof createPGliteFixture>>) {
  const { store, template } = fixture;
  const runtimeId = randomUUID();
  const now = new Date();
  await store.insertWarmPoolRuntime({
    id: runtimeId,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateDigest: template.digest,
    driverKind: "docker",
    eligibilityFingerprint: "sha256:eligible",
    state: "ready",
    providerRef: { kind: "docker", id: "warm-provider" },
    enrollmentDigest: null,
    enrollmentExpiresAt: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
    readyAt: now,
    leasedAt: null,
    failureCode: null,
  });
  return runtimeId;
}

async function expectWarmAdmission(
  store: Store,
  warmWorkspace: WorkspaceRow,
  claim: WarmPoolClaim,
  admitted: WorkspaceRow | undefined,
) {
  expect(admitted).toMatchObject({
    state: "provisioning",
    provisioningMode: "warm",
    changeSeq: warmWorkspace.changeSeq + 1,
    providerRef: { kind: "docker", id: "warm-provider" },
    registrationDigest: claim.registrationDigest,
    registrationExpiresAt: claim.registrationExpiresAt,
    launchAttempts: 1,
  });
  expect(await store.listStateHistory(warmWorkspace.id)).toHaveLength(2);
  const events = (await store.claimDueEvents(new Date(), 20)).filter((event) => event.workspaceId === warmWorkspace.id);
  expect(events.map((event) => event.eventType)).toEqual(["workspace.queued", "workspace.provisioning"]);
  expect(EventEnvelopeSchema.parse(events[1]?.payload).workspace).toMatchObject({
    state: "provisioning",
    provisioning_mode: "warm",
    change_cursor: admitted?.changeSeq,
    outputs: warmWorkspace.outputs,
  });
}

async function expectNextWarmClaim(
  fixture: Awaited<ReturnType<typeof createPGliteFixture>>,
  claim: WarmPoolClaim,
  nextRuntimeId: string,
) {
  const { store } = fixture;
  const nextInserted = await insertTestWorkspace(fixture, "pg-warm-next");
  const nextWorkspace = { ...nextInserted, outputs: { artifact: "next" }, changeSeq: nextInserted.changeSeq + 1 };
  await store.updateWorkspace(nextInserted.id, { outputs: nextWorkspace.outputs }, new Date());
  const nextClaim = {
    ...claim,
    workspace: nextWorkspace,
    registrationDigest: new TextEncoder().encode("next-secret"),
    registrationExpiresAt: new Date(claim.registrationExpiresAt.getTime() + 1000),
    at: new Date(),
  };
  const nextAdmission = findLease([await store.claimWarmPoolRuntime(nextClaim)]);
  expect(nextAdmission?.runtime).toMatchObject({ id: nextRuntimeId, workspaceId: nextWorkspace.id });
  await expectWarmAdmission(store, nextWorkspace, nextClaim, nextAdmission?.workspace);
}

async function expectFreshPurgeFence(fixture: Awaited<ReturnType<typeof createPGliteFixture>>, claim: WarmPoolClaim) {
  const { store } = fixture;
  expect(await store.claimWarmPoolRuntime(claim)).toBeNull();
  expect(await store.getWorkspace(claim.workspace.id)).toMatchObject({ state: "queued", providerRef: null });
  expect(await store.listStateHistory(claim.workspace.id)).toHaveLength(1);
  const runtimeId = await insertReadyRuntime(fixture);
  const now = new Date();
  await store.insertOperation({
    id: randomUUID(),
    principalId: fixture.principal.id,
    kind: "purge",
    state: "pending",
    idempotencyKey: "fresh-purge-fence",
    requestDigest: "fresh-purge-fence",
    workspaceId: claim.workspace.id,
    checkpointId: null,
    resultWorkspaceId: null,
    reasonCode: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  expect(await store.claimWarmPoolRuntime(claim)).toBeNull();
  expect(await store.getWarmPoolRuntime(runtimeId)).toMatchObject({ state: "ready", workspaceId: null });
  expect(await store.listStateHistory(claim.workspace.id)).toHaveLength(1);
}

describe.each(["memory", "disk"] as const)("PGlite workspace capabilities (%s)", (mode) => {
  test("round-trips identity, templates, workspaces, and conversations", async () => {
    const fixture = await createPGliteFixture("pkt_workspace", mode);
    const { parsed, principal, store, template } = fixture;
    try {
      const inheritedKeyId = randomUUID();
      await store.insertMachineKey({
        id: inheritedKeyId,
        principalId: principal.id,
        secretDigest: new Uint8Array([1, 2, 3]),
        scopes: [],
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      });
      expect(await store.updatePrincipal(principal.id, ["admin", "templates:read"], ["pg-fixture"])).toMatchObject({
        scopes: ["admin", "templates:read"],
        templateNames: ["pg-fixture"],
      });
      expect((await store.getMachineKeyWithPrincipal(inheritedKeyId))?.key.scopes).toEqual([]);

      expect(
        (
          await store.upsertTemplate({
            name: template.name,
            version: template.version,
            digest: template.digest,
            description: null,
            spec: parsed.manifest.spec,
          })
        ).conflict,
      ).toBe(false);
      expect(
        (
          await store.upsertTemplate({
            name: template.name,
            version: template.version,
            digest: "sha256:different",
            description: null,
            spec: parsed.manifest.spec,
          })
        ).conflict,
      ).toBe(true);

      const workspace = await insertTestWorkspace(fixture, "pg-task", { source: "test" });
      const replay = await store.insertWorkspace({
        id: randomUUID(),
        principalId: principal.id,
        externalId: "pg-task",
        idempotencyKey: "pg-task",
        requestDigest: digestOf({ externalId: "pg-task" }),
        templateId: template.id,
        templateSnapshot: snapshotOf(parsed),
        launchInput: { code: "opaque" },
        metadata: {},
        deadlineAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      });
      expect(replay.kind).toBe("replayed");
      expect(workspaceOf(replay).id).toBe(workspace.id);
      expect(
        (await store.listWorkspaces(principal.id, { metadata: { source: "test" }, limit: 10 })).map((row) => row.id),
      ).toContain(workspace.id);

      const message = {
        workspaceId: workspace.id,
        messageId: "pg-message-1",
        role: "assistant" as const,
        content: "durable response",
        occurredAt: new Date(),
        metadata: { provider: "agentapi" },
        createdAt: new Date(),
      };
      expect((await store.appendConversationMessage(message)).created).toBe(true);
      expect((await store.appendConversationMessage(message)).created).toBe(false);
      expect(await store.readConversation(workspace.id, 0, 10)).toEqual([
        expect.objectContaining({ seq: 1, messageId: "pg-message-1", content: "durable response" }),
      ]);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  test("round-trips warm claims, transitions, logs, and network events", async () => {
    const fixture = await createPGliteFixture("pkt_runtime", mode);
    const { store } = fixture;
    try {
      const inserted = await insertTestWorkspace(fixture, "pg-warm-task");
      const warmWorkspace = { ...inserted, outputs: { artifact: "retained" }, changeSeq: inserted.changeSeq + 1 };
      await store.updateWorkspace(inserted.id, { outputs: warmWorkspace.outputs }, new Date());
      const runtimeId = await insertReadyRuntime(fixture);
      const nextRuntimeId = await insertReadyRuntime(fixture);
      await store.updateWarmPoolRuntime(nextRuntimeId, { readyAt: new Date(Date.now() + 1000) }, new Date());
      await fixture.context.client.exec("SET enable_hashjoin=off; SET enable_mergejoin=off");
      const claim = {
        workspace: warmWorkspace,
        driverKind: "docker",
        eligibilityFingerprint: "sha256:eligible",
        registrationDigest: new TextEncoder().encode("one-time"),
        registrationExpiresAt: new Date(Date.now() + 60_000),
        at: new Date(),
      };
      const warmChanged = store.waitForWorkspaceChange(warmWorkspace.id, warmWorkspace.changeSeq, 1000);
      const claims = await Promise.all([store.claimWarmPoolRuntime(claim), store.claimWarmPoolRuntime(claim)]);
      await warmChanged;
      await expectWarmAdmission(store, warmWorkspace, claim, findLease(claims)?.workspace);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await store.getWorkspace(warmWorkspace.id))?.provisioningMode).toBe("warm");
      expect((await store.getWarmPoolRuntime(runtimeId))?.workspaceId).toBe(warmWorkspace.id);

      expect(findLease(claims)?.runtime).toMatchObject({
        id: runtimeId,
        state: "leased",
      });
      expect(await store.getWarmPoolRuntime(nextRuntimeId)).toMatchObject({ state: "ready", workspaceId: null });
      await expectNextWarmClaim(fixture, claim, nextRuntimeId);
      await store.updateWarmPoolRuntime(nextRuntimeId, { state: "failed" }, new Date());
      const miss = await insertTestWorkspace(fixture, "pg-warm-miss");
      await expectFreshPurgeFence(fixture, { ...claim, workspace: miss });

      const workspace = await insertTestWorkspace(fixture, "pg-state-task");
      const provisioning = await store.transition(workspace.id, {
        from: ["queued"],
        to: "provisioning",
        at: new Date(),
        patch: { launchAttempts: 1 },
      });
      const changeCursor = provisioning?.changeSeq ?? 0;
      const changed = store.waitForWorkspaceChange(workspace.id, changeCursor, 1000);
      await store.updateWorkspace(workspace.id, { health: { agent: "healthy" } }, new Date());
      await changed;
      expect((await store.getWorkspace(workspace.id))?.changeSeq).toBe(changeCursor + 1);
      expect(
        await store.transition(workspace.id, {
          from: ["provisioning"],
          to: "ready",
          at: new Date(),
        }),
      ).toBeNull();
      expect(
        await store.transition(workspace.id, {
          from: ["provisioning"],
          to: "failed",
          reason: "launch_failed",
          at: new Date(),
          patch: { launchInput: null, registrationDigest: null },
        }),
      ).toMatchObject({ state: "failed", terminalAt: expect.any(Date) });
      expect(
        (await store.claimDueEvents(new Date(), 20))
          .filter((event) => event.workspaceId === workspace.id)
          .map((event) => event.eventType),
      ).toEqual(["workspace.queued", "workspace.provisioning", "workspace.failed"]);

      await store.appendLogs(workspace.id, [
        { stream: "runtime", occurredAt: new Date(), content: new TextEncoder().encode("hello") },
        {
          stream: "stderr",
          occurredAt: new Date(),
          content: new TextEncoder().encode("\nPermissionError: /home/onefin/.pi\n"),
        },
      ]);
      expect(new TextDecoder().decode((await store.readLogs(workspace.id, 0, 10))[0]?.content)).toBe("hello");
      const tail = await store.readLogTail(workspace.id, 24);
      expect(new TextDecoder().decode(tail.content)).toBe("Error: /home/onefin/.pi\n");
      expect(tail).toMatchObject({ truncated: true, lastSeq: 2 });

      const sessionId = randomUUID();
      const event = {
        source_seq: 1,
        occurred_at: new Date().toISOString(),
        decision: "deny" as const,
        transport: "https" as const,
        host: "blocked.example",
        port: 443,
        method: null,
        path: null,
        matched_rule: null,
        reason: "no_matching_rule",
      };
      await store.appendNetworkEvents(workspace.id, sessionId, [event]);
      await store.appendNetworkEvents(workspace.id, sessionId, [event]);
      expect(await store.readNetworkEvents(workspace.id, 0, 10)).toEqual([
        expect.objectContaining({ seq: 1, sourceSessionId: sessionId, source_seq: 1 }),
      ]);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  test("a failed warm transition rolls back the runtime claim", async () => {
    const fixture = await createPGliteFixture("pkt_warm_rollback", mode);
    try {
      const workspace = await insertTestWorkspace(fixture, "warm-rollback");
      const runtimeId = await insertReadyRuntime(fixture);
      await fixture.query('DROP TABLE "pocketcoder"."event_outbox"');
      await expect(
        fixture.store.claimWarmPoolRuntime({
          workspace,
          driverKind: "docker",
          eligibilityFingerprint: "sha256:eligible",
          registrationDigest: new TextEncoder().encode("rollback"),
          registrationExpiresAt: new Date(Date.now() + 60_000),
          at: new Date(),
        }),
      ).rejects.toThrow();
      expect(await fixture.store.getWorkspace(workspace.id)).toMatchObject({ state: "queued", providerRef: null });
      expect(await fixture.store.getWarmPoolRuntime(runtimeId)).toMatchObject({ state: "ready", workspaceId: null });
      expect(await fixture.store.listStateHistory(workspace.id)).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});
