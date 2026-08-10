import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import {
  createPostgresFixture,
  insertTestWorkspace,
  TEST_DATABASE_URL,
  workspaceOf,
} from "../test-fixtures";

describe.skipIf(!TEST_DATABASE_URL)("postgres workspace capabilities", () => {
  test("round-trips identity, templates, workspaces, and conversations", async () => {
    const fixture = await createPostgresFixture("pkt_workspace");
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
      expect(
        await store.updatePrincipal(principal.id, ["admin", "templates:read"], ["pg-fixture"]),
      ).toMatchObject({ scopes: ["admin", "templates:read"], templateNames: ["pg-fixture"] });
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
        (await store.listWorkspaces(principal.id, { metadata: { source: "test" }, limit: 10 })).map(
          (row) => row.id,
        ),
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
    const fixture = await createPostgresFixture("pkt_runtime");
    const { store, template } = fixture;
    try {
      const warmWorkspace = await insertTestWorkspace(fixture, "pg-warm-task");
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
      const claim = {
        workspaceId: warmWorkspace.id,
        templateDigest: template.digest,
        driverKind: "docker",
        eligibilityFingerprint: "sha256:eligible",
        registrationDigest: new TextEncoder().encode("one-time"),
        registrationExpiresAt: new Date(Date.now() + 60_000),
        at: new Date(),
      };
      const claims = await Promise.all([
        store.claimWarmPoolRuntime(claim),
        store.claimWarmPoolRuntime(claim),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await store.getWorkspace(warmWorkspace.id))?.provisioningMode).toBe("warm");
      expect((await store.getWarmPoolRuntime(runtimeId))?.workspaceId).toBe(warmWorkspace.id);

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
      expect(
        new TextDecoder().decode((await store.readLogs(workspace.id, 0, 10))[0]?.content),
      ).toBe("hello");
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
});
