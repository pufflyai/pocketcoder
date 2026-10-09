import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

async function fixture() {
  const f = await checkpointHttpFixture();
  const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
  const upload = await f.grant;
  expect((await fetch(upload.url, { method: "PUT", headers: f.headers(upload), body: f.raw })).status).toBe(201);
  await pending;
  const now = new Date();
  const id = randomUUID();
  const inserted = await f.store.insertWorkspace({
    id,
    principalId: f.principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: id,
    templateId: f.template.id,
    templateSnapshot: f.workspace.templateSnapshot,
    launchInput: null,
    metadata: {},
    deadlineAt: new Date(Date.now() + 30_000),
    createdAt: now,
    originWorkspaceId: f.workspace.id,
    restoredFromCheckpointId: f.checkpoint.id,
    launchMode: "restore",
  });
  if (inserted.kind !== "created") throw new Error("destination was not created");
  await f.store.transition(id, { from: ["queued"], to: "provisioning", at: now });
  await f.store.transition(id, { from: ["provisioning"], to: "connected", at: now });
  await f.store.updateWorkspace(id, { connectionEpoch: 5 }, now);
  const destination = (await f.store.getWorkspace(id)) as WorkspaceRow;
  const operationId = randomUUID();
  await f.store.insertOperation({
    id: operationId,
    principalId: f.principal.id,
    kind: "restore",
    state: "running",
    idempotencyKey: operationId,
    requestDigest: operationId,
    workspaceId: f.workspace.id,
    checkpointId: f.checkpoint.id,
    resultWorkspaceId: id,
    reasonCode: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  const connected = await f.connect(id, 5);
  const grant = await f.service.restoreGrant(connected.conn, destination);
  if (!grant) throw new Error("fresh restore grant missing");
  const headers: Record<string, string> = {
    authorization: `Bearer ${grant.credential}`,
    "x-checkpoint-transfer-id": grant.transfer_id,
    "x-pocketcoder-workspace": id,
    "x-pocketcoder-connection": connected.conn.connectionId,
    "x-pocketcoder-epoch": "5",
    "x-pocketcoder-operation": operationId,
  };
  return {
    ...f,
    destination,
    operationId,
    connected,
    grant,
    headers,
    async dispose() {
      connected.socket.close();
      await f.dispose();
    },
  };
}

test("fresh destination HTTP grant streams source bytes and completes only after verified installed barrier", async () => {
  const f = await fixture();
  try {
    const payload = {
      operation_id: f.operationId,
      transfer_id: f.grant.transfer_id,
      checkpoint_id: f.checkpoint.id,
      archive_digest: f.grant.source.archive_digest,
      phase: "installed" as const,
    };
    expect((await f.store.getOperation(f.operationId))?.state).toBe("running");
    const response = await fetch(f.grant.url, { headers: f.headers });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.raw);
    expect((await f.store.checkpointTransfers.get(f.grant.transfer_id))?.state).toBe("validated");
    expect((await f.store.getOperation(f.operationId))?.state).toBe("running");
    expect(await f.service.installed(f.connected.conn, payload)).toBe(true);
    expect((await f.store.getOperation(f.operationId))?.state).toBe("running");
    f.connected.conn.restoreInstalled = true;
    f.connected.conn.harnessRunning = true;
    expect(await f.service.ready(f.connected.conn)).toBe(true);
    expect((await f.store.getWorkspace(f.destination.id))?.state).toBe("ready");
    expect((await f.store.getOperation(f.operationId))?.state).toBe("succeeded");
    expect((await f.store.checkpointTransfers.get(f.grant.transfer_id))?.state).toBe("complete");
    expect((await fetch(f.grant.url, { headers: f.headers })).status).toBe(401);
  } finally {
    await f.dispose();
  }
});

test.each(["owner", "operation", "epoch", "purpose"])(
  "HTTP grant refuses wrong %s without consumption",
  async (failure) => {
    const f = await fixture();
    try {
      const headers = { ...f.headers };
      if (failure === "owner") headers["x-pocketcoder-workspace"] = f.workspace.id;
      if (failure === "operation") headers["x-pocketcoder-operation"] = randomUUID();
      if (failure === "epoch") headers["x-pocketcoder-epoch"] = "3";
      const response = await fetch(f.grant.url, { method: failure === "purpose" ? "PUT" : "GET", headers });
      expect(response.status).toBe(401);
      expect((await f.store.checkpointTransfers.get(f.grant.transfer_id))?.state).toBe("granted");
      expect((await f.store.getOperation(f.operationId))?.state).toBe("running");
    } finally {
      await f.dispose();
    }
  },
);

test("normal destination disconnect drains download handles and revokes its one-use grant", async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.grant.url, { headers: f.headers });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await f.service.disconnected(f.connected.conn);
    await reader?.cancel().catch(() => {});
    const row = await f.store.checkpointTransfers.get(f.grant.transfer_id);
    expect(row?.state).toBe("aborted");
    expect(row?.grantDigest).toBeNull();
    expect((await f.store.getOperation(f.operationId))?.state).toBe("running");
    const payload = {
      operation_id: f.operationId,
      transfer_id: f.grant.transfer_id,
      checkpoint_id: f.checkpoint.id,
      archive_digest: f.grant.source.archive_digest,
      phase: "installed" as const,
    };
    expect(await f.service.installed(f.connected.conn, payload)).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("the final declared HTTP chunk proves native EOF before installation can arrive", async () => {
  const f = await fixture();
  try {
    const response = await f.service.handleDownload(new Request(f.grant.url, { headers: f.headers }), f.operationId);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("download body missing");
    const last = await reader.read();
    expect(last.done).toBe(false);
    expect(Buffer.from(last.value ?? [])).toEqual(f.raw);
    expect((await f.store.checkpointTransfers.get(f.grant.transfer_id))?.state).toBe("validated");
    const payload = {
      operation_id: f.operationId,
      transfer_id: f.grant.transfer_id,
      checkpoint_id: f.checkpoint.id,
      archive_digest: f.grant.source.archive_digest,
      phase: "installed" as const,
    };
    expect(await f.service.installed(f.connected.conn, payload)).toBe(true);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  } finally {
    await f.dispose();
  }
});
