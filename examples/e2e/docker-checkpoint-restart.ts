import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { assertRecoverableSource, cancelRecoverableSource } from "./checkpoint-rejection";
import { checkpointSourceFixture } from "./checkpoint-source-fixture";
import { command, waitFor } from "./local-process";

const fixture = await checkpointSourceFixture();
try {
  const source = await fixture.createSource();
  const bytes = Buffer.from(Array.from({ length: 131072 }, (_, index) => index % 256));
  await command(
    [
      "docker",
      "exec",
      `pocketcoder-ws-${source.workspaceId}`,
      "bun",
      "-e",
      "await Bun.write('/work/recoverable', Buffer.from(Array.from({length:131072}, (_, index) => index % 256)));",
    ],
    { quiet: true },
  );
  const key = randomUUID();
  fixture.proxy.interruptNextUpload(fixture.restart);
  const response = await source.request(`/v1/workspaces/${source.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": key },
    body: "{}",
  });
  const interrupted = PreserveResponseSchema.parse(await response.json());
  await waitFor(
    async () => {
      const response = await source.request(`/v1/operations/${interrupted.operation.id}`).catch(() => null);
      if (!response?.ok) return false;
      const operation = OperationResourceSchema.parse(await response.json());
      if (operation.state === "succeeded") throw new Error("Interrupted upload became available.");
      return operation.state === "failed";
    },
    30_000,
    "interrupted preserve recovery",
  );
  await assertRecoverableSource(source, bytes);
  const retry = await source.request(`/v1/workspaces/${source.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": key },
    body: "{}",
  });
  if (retry.ok) throw new Error("Interrupted idempotency key created a new preserve.");
  await cancelRecoverableSource(source);

  const next = await fixture.createSource();
  await command(
    [
      "docker",
      "exec",
      `pocketcoder-ws-${next.workspaceId}`,
      "bun",
      "-e",
      "await Bun.write('/work/known', 'survives controller restart');",
    ],
    { quiet: true },
  );
  const preserved = PreserveResponseSchema.parse(
    await (
      await next.request(`/v1/workspaces/${next.workspaceId}/preserve`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: "{}",
      })
    ).json(),
  );
  await waitFor(
    async () =>
      OperationResourceSchema.parse(await (await next.request(`/v1/operations/${preserved.operation.id}`)).json())
        .state === "succeeded",
    30_000,
    "durable preserve",
  );
  await fixture.restart();
  const restored = RestoreResponseSchema.parse(
    await (
      await next.request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ external_id: randomUUID() }),
      })
    ).json(),
  );
  fixture.ownWorkspace(restored.workspace.id);
  await waitFor(
    async () =>
      WorkspaceResourceSchema.parse(await (await next.request(`/v1/workspaces/${restored.workspace.id}`)).json())
        .state === "ready",
    30_000,
    "restore after restart",
  );
  const read = await command(["docker", "exec", `pocketcoder-ws-${restored.workspace.id}`, "cat", "/work/known"], {
    quiet: true,
  });
  if (read.stdout.trim() !== "survives controller restart") throw new Error("Restored bytes changed across restart.");
  await next.request(`/v1/workspaces/${restored.workspace.id}/cancel`, { method: "POST" });
  await fixture.stop();
  const store = await PGliteStore.create(fixture.dataDir);
  try {
    const usage = await store.storageReservations.usage(null, null);
    if (usage.outstanding.bytes || usage.outstanding.files)
      throw new Error("Interrupted bytes remain charged after owned cleanup.");
    if ((await readdir(fixture.checkpointDir)).length !== 1) throw new Error("Restart left publication scratch.");
    console.log(
      JSON.stringify({
        result: "passed",
        interruptedBytes: bytes.length,
        checkpointId: preserved.checkpoint.id,
        destinationId: restored.workspace.id,
        outstandingBytes: usage.outstanding.bytes,
      }),
    );
  } finally {
    await store.close();
  }
} finally {
  await fixture.dispose();
}
