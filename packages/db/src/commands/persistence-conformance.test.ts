import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createPostgresFixture, insertTestWorkspace, TEST_DATABASE_URL } from "../test-fixtures";

describe.skipIf(!TEST_DATABASE_URL)("postgres persistence capabilities", () => {
  test("round-trips storage, checkpoints, operations, and outputs", async () => {
    const fixture = await createPostgresFixture("pkt_persistence");
    const { parsed, principal, schema, sql, store } = fixture;
    try {
      const workspace = await insertTestWorkspace(fixture, "pg-persistence-task");
      const storageId = randomUUID();
      const now = new Date();
      await store.insertWorkspaceStorage({
        id: storageId,
        workspaceId: workspace.id,
        principalId: principal.id,
        providerKind: "filesystem",
        providerRef: { kind: "filesystem", id: storageId, root: "/opaque" },
        state: "retained",
        mountManifest: parsed.manifest.spec.persistence.mounts,
        logicalBytes: 12,
        fileCount: 1,
        retainedUntil: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastErrorCode: null,
      });
      const checkpointId = randomUUID();
      const manifest = {
        format: "pocketcoder-checkpoint/v1" as const,
        checkpoint_id: checkpointId,
        template_digest: parsed.digest,
        mounts: [{ name: "worktree", entries: [] }],
        logical_bytes: 0,
        file_count: 0,
      };
      await store.insertCheckpoint({
        id: checkpointId,
        workspaceId: workspace.id,
        principalId: principal.id,
        storageId,
        parentCheckpointId: null,
        state: "ready",
        reasonCode: null,
        providerKind: "filesystem",
        providerRef: { kind: "filesystem", id: checkpointId, root: "/opaque-checkpoint" },
        templateSnapshot: snapshotOf(parsed),
        templateDigest: parsed.digest,
        sourceProvenance: null,
        manifest,
        manifestDigest: digestOf(manifest),
        logicalBytes: 0,
        storedBytes: 0,
        fileCount: 0,
        conversationRestore: "filesystem_only",
        label: "postgres-roundtrip",
        createdAt: now,
        updatedAt: now,
        readyAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        deletedAt: null,
      });
      expect(
        await store.insertOperation({
          id: randomUUID(),
          principalId: principal.id,
          kind: "verify",
          state: "succeeded",
          idempotencyKey: "verify-pg",
          requestDigest: digestOf({ checkpointId }),
          workspaceId: workspace.id,
          checkpointId,
          resultWorkspaceId: null,
          reasonCode: null,
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        }),
      ).toMatchObject({ created: true });
      expect((await store.getCheckpoint(checkpointId))?.label).toBe("postgres-roundtrip");
      expect((await store.checkpointUsage(principal.id)).count).toBe(1);
      await store.appendOutput({
        workspaceId: workspace.id,
        seq: 0,
        name: "commit",
        value: "a".repeat(40),
        occurredAt: now,
      });
      expect((await store.listOutputs(workspace.id))[0]?.name).toBe("commit");

      let invalidStateRejected = false;
      try {
        await sql.unsafe(
          `UPDATE "${schema}"."workspaces" SET state = 'not-a-state' WHERE id = $1`,
          [workspace.id],
        );
      } catch {
        invalidStateRejected = true;
      }
      expect(invalidStateRejected).toBe(true);
      const foreign = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'workspace%'`,
      )) as Array<{ n: number }>;
      expect(foreign[0]?.n).toBe(0);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
