import { randomUUID } from "node:crypto";
import { chmod, readdir } from "node:fs/promises";
import {
  CheckpointResourceSchema,
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { checkpointSourceFixture } from "./checkpoint-source-fixture";
import type { ReadyHarnessWorkspace } from "./contract";
import { command, waitFor } from "./local-process";

// The transfer deadline is 60 seconds. Purge must cancel a transfer, not wait for it to expire.
const PURGE_BUDGET_MS = 20_000;

function hold() {
  let started!: (headers: Headers) => void;
  let release!: () => void;
  const headers = new Promise<Headers>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    headers,
    release,
    interruption(value: Headers) {
      started(value);
      return released;
    },
  };
}

async function read(client: ReadyHarnessWorkspace, path: string) {
  const response = await client.request(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

const operation = async (client: ReadyHarnessWorkspace, id: string) =>
  OperationResourceSchema.parse(await read(client, `/v1/operations/${id}`));
const workspace = async (client: ReadyHarnessWorkspace, id: string) =>
  WorkspaceResourceSchema.parse(await read(client, `/v1/workspaces/${id}`));

async function writePrivateBytes(client: ReadyHarnessWorkspace) {
  await command(
    [
      "docker",
      "exec",
      `pocketcoder-ws-${client.workspaceId}`,
      "bun",
      "-e",
      "await Bun.write('/work/private', Buffer.alloc(131072, 7));",
    ],
    { quiet: true },
  );
}

async function preserve(client: ReadyHarnessWorkspace) {
  const response = await client.request(`/v1/workspaces/${client.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: "{}",
  });
  return PreserveResponseSchema.parse(await response.json());
}

async function preserved(client: ReadyHarnessWorkspace) {
  const result = await preserve(client);
  await waitFor(
    async () => (await operation(client, result.operation.id)).state === "succeeded",
    30_000,
    "durable preserve",
  );
  return result;
}

async function restore(client: ReadyHarnessWorkspace, checkpointId: string) {
  return client.request(`/v1/checkpoints/${checkpointId}/restore`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ external_id: randomUUID() }),
  });
}

async function purge(client: ReadyHarnessWorkspace, workspaceId: string) {
  const response = await client.request(`/v1/workspaces/${workspaceId}/purge`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: "{}",
  });
  if (response.status !== 202) throw new Error(`Purge was not admitted: ${await response.text()}`);
  return { id: OperationResourceSchema.parse(await response.json()).id, started: Date.now() };
}

async function assertNoContainer(workspaceId: string) {
  const listed = await command(["docker", "ps", "-aq", "--filter", `name=^/pocketcoder-ws-${workspaceId}$`], {
    quiet: true,
  });
  if (listed.stdout) throw new Error(`Workspace ${workspaceId} kept its container.`);
}

async function assertPurged(
  client: ReadyHarnessWorkspace,
  workspaceId: string,
  purged: { id: string; started: number },
) {
  await waitFor(
    async () => (await operation(client, purged.id)).state === "succeeded",
    PURGE_BUDGET_MS,
    "purge during an active checkpoint transfer",
  );
  const elapsedMs = Date.now() - purged.started;
  const row = await workspace(client, workspaceId);
  if (!["canceled", "preserved"].includes(row.state)) throw new Error(`Purged workspace is ${row.state}.`);
  await assertNoContainer(workspaceId);
  return elapsedMs;
}

async function assertLateWriteRejected(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  await response.body?.cancel();
  if (response.status !== 401) throw new Error(`A late ${init.method} after purge returned ${response.status}.`);
}

const fixture = await checkpointSourceFixture();
try {
  const before = new Set(await readdir(fixture.checkpointDir));
  const purgedIds: string[] = [];

  // 1. Purge while the source is uploading its checkpoint.
  const uploading = await fixture.createSource();
  await writePrivateBytes(uploading);
  const upload = hold();
  fixture.proxy.interruptNextUpload(upload.interruption);
  const pendingPreserve = await preserve(uploading);
  const uploadGrant = await upload.headers;
  let uploadPurgeMs: number;
  try {
    uploadPurgeMs = await assertPurged(uploading, uploading.workspaceId, await purge(uploading, uploading.workspaceId));
  } finally {
    upload.release();
  }
  purgedIds.push(uploading.workspaceId);
  if ((await operation(uploading, pendingPreserve.operation.id)).state === "succeeded")
    throw new Error("A purged upload published a checkpoint.");
  await assertLateWriteRejected(`${fixture.agentUrl}/v1/agent/checkpoints/${pendingPreserve.operation.id}/archive`, {
    method: "PUT",
    headers: uploadGrant,
    body: Buffer.alloc(1024, 1),
  });

  // 2. Purge the source while another workspace downloads its checkpoint.
  const origin = await fixture.createSource();
  await writePrivateBytes(origin);
  const checkpoint = (await preserved(origin)).checkpoint;
  const download = hold();
  fixture.proxy.holdNextDownload(download.interruption);
  const restored = RestoreResponseSchema.parse(await (await restore(origin, checkpoint.id)).json());
  fixture.ownWorkspace(restored.workspace.id);
  const downloadGrant = await download.headers;
  let downloadPurgeMs: number;
  try {
    downloadPurgeMs = await assertPurged(origin, origin.workspaceId, await purge(origin, origin.workspaceId));
  } finally {
    download.release();
  }
  purgedIds.push(origin.workspaceId);
  const target = await workspace(origin, restored.workspace.id);
  if (target.state !== "failed" || target.reason_code !== "restore_failed")
    throw new Error(`The purged restore destination is ${target.state}/${target.reason_code}.`);
  await assertNoContainer(target.id);
  if ((await operation(origin, restored.operation.id)).state !== "failed")
    throw new Error("A restore of purged content did not fail.");
  await assertLateWriteRejected(`${fixture.agentUrl}/v1/agent/checkpoints/${restored.operation.id}/archive`, {
    method: "GET",
    headers: downloadGrant,
  });
  if ((await restore(origin, checkpoint.id)).ok) throw new Error("The old checkpoint receipt restored purged content.");

  // 3. Purge a restore destination while it downloads. Its source keeps its own checkpoint.
  const kept = await fixture.createSource();
  await writePrivateBytes(kept);
  const keptCheckpoint = (await preserved(kept)).checkpoint;
  const copying = hold();
  fixture.proxy.holdNextDownload(copying.interruption);
  const copy = RestoreResponseSchema.parse(await (await restore(kept, keptCheckpoint.id)).json());
  fixture.ownWorkspace(copy.workspace.id);
  await copying.headers;
  let destinationPurgeMs: number;
  try {
    destinationPurgeMs = await assertPurged(kept, copy.workspace.id, await purge(kept, copy.workspace.id));
  } finally {
    copying.release();
  }
  purgedIds.push(copy.workspace.id);
  if ((await operation(kept, copy.operation.id)).state !== "failed")
    throw new Error("A purged destination completed its restore.");
  const source = CheckpointResourceSchema.parse(await read(kept, `/v1/checkpoints/${keptCheckpoint.id}`));
  if (source.state !== "ready") throw new Error("Purging a destination changed its source checkpoint.");
  await assertPurged(kept, kept.workspaceId, await purge(kept, kept.workspaceId));
  purgedIds.push(kept.workspaceId);

  // 4. Interrupt archive deletion, restart the controller, and let purge retry.
  const interrupted = await fixture.createSource();
  await writePrivateBytes(interrupted);
  const archive = (await preserved(interrupted)).checkpoint;
  await chmod(fixture.checkpointDir, 0o500);
  const blocked = await purge(interrupted, interrupted.workspaceId);
  await waitFor(
    async () => (await operation(interrupted, blocked.id)).reason_code === "purge_storage_unavailable",
    PURGE_BUDGET_MS,
    "blocked archive deletion",
  );
  let chargedWhileBlocked = 0;
  await fixture.restart(async () => {
    const files = await readdir(fixture.checkpointDir);
    if (!files.some((name) => name.startsWith(archive.id))) throw new Error("Blocked deletion removed the archive.");
    const store = await PGliteStore.create(fixture.dataDir);
    try {
      chargedWhileBlocked = (await store.storageReservations.usage(interrupted.workspaceId, null)).workspace.bytes;
    } finally {
      await store.close();
    }
    if (!chargedWhileBlocked) throw new Error("Remaining archive bytes were released before removal.");
    await chmod(fixture.checkpointDir, 0o700);
  });
  await assertPurged(interrupted, interrupted.workspaceId, blocked);
  purgedIds.push(interrupted.workspaceId);

  const left = (await readdir(fixture.checkpointDir)).filter((name) => !before.has(name));
  if (left.length) throw new Error(`Purge left checkpoint files: ${left.join(", ")}`);
  await fixture.stop();
  const store = await PGliteStore.create(fixture.dataDir);
  try {
    for (const id of purgedIds) {
      const usage = await store.storageReservations.usage(id, null);
      if (usage.workspace.bytes || usage.workspace.files) throw new Error(`Purged workspace ${id} is still charged.`);
    }
    const usage = await store.storageReservations.usage(null, null);
    if (usage.outstanding.bytes || usage.outstanding.files) throw new Error("Canceled transfers remain charged.");
    console.log(
      JSON.stringify({
        result: "passed",
        uploadPurgeMs,
        downloadPurgeMs,
        destinationPurgeMs,
        chargedWhileBlocked,
        outstandingBytes: usage.outstanding.bytes,
      }),
    );
  } finally {
    await store.close();
  }
} finally {
  await chmod(fixture.checkpointDir, 0o700).catch(() => {});
  await fixture.dispose();
}
