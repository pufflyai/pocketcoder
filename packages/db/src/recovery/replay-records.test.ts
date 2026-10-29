import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "../test-fixtures";
import { createRecordReplay } from "./replay-records";

// A PostgreSQL restore rolls content back; the journal brings purges and deletions forward again.
test("replaying a purge removes the workspace's content again, and a deleted checkpoint stays deleted", async () => {
  const f = await createPGliteFixture("pc-replay-purge");
  try {
    const workspace = await insertTestWorkspace(f, "purged");
    const at = new Date();
    await f.store.appendWorkspaceMessage({
      workspaceId: workspace.id,
      messageId: "m",
      role: "user",
      content: "private",
      occurredAt: at,
      metadata: {},
      createdAt: at,
    });
    await f.store.appendLogs(workspace.id, [
      { stream: "stdout", content: new TextEncoder().encode("log"), occurredAt: at },
    ]);
    const storageId = randomUUID();
    await f.store.insertWorkspaceStorage({
      id: storageId,
      workspaceId: workspace.id,
      principalId: f.principal.id,
      providerKind: "filesystem",
      providerRef: { kind: "filesystem", root: "/tmp/none" },
      state: "retained",
      mountManifest: [],
      logicalBytes: null,
      fileCount: null,
      retainedUntil: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      lastErrorCode: null,
    } as never);
    const checkpointId = randomUUID();
    await f.store.insertCheckpoint({
      id: checkpointId,
      workspaceId: workspace.id,
      principalId: f.principal.id,
      storageId,
      parentCheckpointId: null,
      state: "ready",
      reasonCode: null,
      providerKind: "filesystem",
      providerRef: { kind: "filesystem", root: "/tmp/none" },
      templateSnapshot: workspace.templateSnapshot,
      templateDigest: workspace.templateDigest,
      sourceProvenance: null,
      manifest: null,
      manifestDigest: null,
      logicalBytes: 1,
      storedBytes: 1,
      fileCount: 1,
      conversationRestore: "filesystem_only",
      label: null,
      createdAt: at,
      updatedAt: at,
      readyAt: at,
      expiresAt: null,
      deletedAt: null,
    });
    const replay = createRecordReplay(f.context);
    await replay({
      kind: "workspace_purged",
      principalId: f.principal.id,
      workspaceId: workspace.id,
      at: at.toISOString(),
    });
    await replay({ kind: "checkpoint_deleted", principalId: f.principal.id, checkpointId, at: at.toISOString() });
    expect(await f.store.readWorkspaceConversation(workspace.id, 0, 10)).toEqual([]);
    expect(await f.store.readLogs(workspace.id, 0, 10)).toEqual([]);
    expect((await f.store.getConversationState(workspace.id))?.status).toBe("deleted");
    expect((await f.store.getCheckpoint(checkpointId))?.state).toBe("deleted");
  } finally {
    await f.dispose();
  }
});
