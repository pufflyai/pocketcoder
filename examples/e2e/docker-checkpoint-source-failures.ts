import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  CheckpointResourceSchema,
  OperationResourceSchema,
  PreserveResponseSchema,
} from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { assertRecoverableSource, assertRejectedCheckpoint, cancelRecoverableSource } from "./checkpoint-rejection";
import { checkpointSourceFixture } from "./checkpoint-source-fixture";
import type { ReadyHarnessWorkspace } from "./contract";
import { command, waitFor } from "./local-process";

async function failedPreserve(source: ReadyHarnessWorkspace, expectedReason: string) {
  const response = await source.request(`/v1/workspaces/${source.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`Failed-source preserve was not admitted: ${await response.text()}`);
  const result = PreserveResponseSchema.parse(await response.json());
  await waitFor(
    async () => {
      const operation = OperationResourceSchema.parse(
        await (await source.request(`/v1/operations/${result.operation.id}`)).json(),
      );
      if (operation.state === "succeeded") throw new Error("Failed-source preserve succeeded");
      if (operation.state !== "failed") return false;
      if (operation.reason_code !== expectedReason)
        throw new Error(`Unexpected failed preserve reason: ${operation.reason_code}`);
      return true;
    },
    30_000,
    "failed-source preserve",
  );
  const checkpoint = CheckpointResourceSchema.parse(
    await (await source.request(`/v1/checkpoints/${result.checkpoint.id}`)).json(),
  );
  if (checkpoint.state !== "failed" || checkpoint.ready_at)
    throw new Error("Failed-source checkpoint became available");
  return { workspaceId: source.workspaceId, checkpointId: result.checkpoint.id, operationId: result.operation.id };
}

async function assertFailedSettlement(
  fixture: Awaited<ReturnType<typeof checkpointSourceFixture>>,
  failures: Array<{
    workspaceId: string;
    checkpointId: string;
    operationId: string;
  }>,
) {
  const store = await PGliteStore.create(fixture.dataDir);
  try {
    await store.init();
    if ((await readdir(fixture.checkpointDir)).length)
      throw new Error("Failed captures left checkpoint scratch or archives");
    const usage = await store.storageReservations.usage(null, null);
    if (usage.instance.bytes || usage.instance.files || usage.outstanding.bytes || usage.outstanding.files)
      throw new Error("Failed captures retained transfer reservation charge");
    for (const failure of failures) {
      const workspace = await store.getWorkspace(failure.workspaceId);
      const checkpoint = await store.getCheckpoint(failure.checkpointId);
      const operation = await store.getOperation(failure.operationId);
      const storage = await store.listWorkspaceStorage(failure.workspaceId);
      if (
        workspace?.state !== "canceled" ||
        workspace.registrationDigest ||
        workspace.registrationExpiresAt ||
        workspace.reconnectDigest ||
        workspace.launchInput
      )
        throw new Error("Explicit failed-source cancellation did not revoke runtime authority");
      if (
        checkpoint?.state !== "failed" ||
        checkpoint.readyAt ||
        checkpoint.providerRef ||
        operation?.state !== "failed" ||
        !operation.completedAt
      )
        throw new Error("Failed capture has durable success metadata");
      if (await store.checkpointTransfers.publication(checkpoint.id))
        throw new Error("Failed capture published an archive");
      if (storage.length !== 1 || storage.some((row) => row.state !== "deleted" || !row.deletedAt))
        throw new Error("Explicit cancellation retained disposable storage");
    }
  } finally {
    await store.close();
  }
}

const fixture = await checkpointSourceFixture();
try {
  const failures = [];
  const fifo = await fixture.createSource();
  failures.push(await assertRejectedCheckpoint(fifo));
  console.log("capture refusal: exact source bytes survived before explicit cancel");
  await cancelRecoverableSource(fifo);
  for (const kind of ["admission", "interruption"] as const) {
    const source = await fixture.createSource();
    const bytes = Buffer.from(Array.from({ length: kind === "admission" ? 256 : 131072 }, (_, index) => index % 256));
    await command(
      [
        "docker",
        "exec",
        `pocketcoder-ws-${source.workspaceId}`,
        "bun",
        "-e",
        `await Bun.write('/work/recoverable', Buffer.from(Array.from({length:${bytes.length}}, (_, index) => index % 256)));${kind === "admission" ? "await Bun.write('/work/second-file', 'measured quota refusal');" : ""}`,
      ],
      { quiet: true },
    );
    if (kind === "interruption") fixture.proxy.interruptNextUpload();
    const failed = await failedPreserve(
      source,
      kind === "admission" ? "checkpoint_quota_exceeded" : "checkpoint_failed",
    );
    await assertRecoverableSource(source, bytes);
    failures.push(failed);
    console.log(`${kind}: ${bytes.length} exact source bytes survived before explicit cancel`);
    await cancelRecoverableSource(source);
  }
  await fixture.stop();
  await assertFailedSettlement(fixture, failures);
  console.log(JSON.stringify({ result: "passed", failures }, null, 2));
} finally {
  await fixture.dispose();
}
