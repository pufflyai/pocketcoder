import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

test("retrying revocation and its workspace fence preserves the cleanup start time", async () => {
  const f = await createPGliteFixture("pc53-revocation");
  try {
    const workspace = await insertTestWorkspace(f, "lease-cleanup");
    const at = workspace.createdAt;
    const version = randomUUID();
    await f.context.db.insert(f.context.tables.secretVersions).values({
      id: version,
      name: "issuer",
      type: "runtime-issuer",
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(1),
      tag: new Uint8Array(16),
      createdAt: at,
    });
    const id = randomUUID();
    await f.context.db.insert(f.context.tables.workspaceLeases).values({
      id,
      workspaceId: workspace.id,
      secretName: "issuer",
      secretVersionId: version,
      purpose: "runtime-issuer",
      templateDigest: workspace.templateDigest,
      policyDigest: "policy",
      requestId: randomUUID(),
      requestDigest: "digest",
      state: "requested",
      createdAt: at,
      updatedAt: at,
      requestExpiresAt: new Date(at.getTime() + 60_000),
    });
    const started = new Date(at.getTime() + 1000);
    await f.store.requestWorkspaceLeaseRevocation(id, started);
    await f.store.requestWorkspaceLeaseRevocation(id, new Date(at.getTime() + 2000));
    await f.store.fenceWorkspaceLeases(workspace.id, new Date(at.getTime() + 3000));
    expect((await f.store.getWorkspaceLease(id))?.updatedAt).toEqual(started);
  } finally {
    await f.dispose();
  }
}, 20_000);
