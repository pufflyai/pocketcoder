import { randomUUID } from "node:crypto";
import {
  CheckpointResourceSchema,
  OperationResourceSchema,
  PreserveResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { ReadyHarnessWorkspace } from "./contract";
import { command, waitFor } from "./local-process";

export async function assertRejectedCheckpoint(source: ReadyHarnessWorkspace) {
  const name = `pocketcoder-ws-${source.workspaceId}`;
  const bytes = Buffer.from([0, 1, 2, 10, 127, 128, 254, 255]);
  await command(
    [
      "docker",
      "exec",
      name,
      "bun",
      "-e",
      `await Bun.write('/work/recoverable', Buffer.from('${bytes.toString("base64")}', 'base64'));`,
    ],
    { quiet: true },
  );
  await command(["docker", "exec", name, "mkfifo", "/work/unsupported-pipe"], { quiet: true });
  const response = await source.request(`/v1/workspaces/${source.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`Capture rejection was not admitted: ${await response.text()}`);
  const preserved = PreserveResponseSchema.parse(await response.json());
  await waitFor(
    async () => {
      const operation = OperationResourceSchema.parse(
        await (await source.request(`/v1/operations/${preserved.operation.id}`)).json(),
      );
      if (operation.state === "succeeded") throw new Error("Unsupported source capture succeeded");
      return operation.state === "failed";
    },
    30_000,
    "rejected capture cleanup",
  );
  const checkpoint = CheckpointResourceSchema.parse(
    await (await source.request(`/v1/checkpoints/${preserved.checkpoint.id}`)).json(),
  );
  const workspace = WorkspaceResourceSchema.parse(
    await (await source.request(`/v1/workspaces/${source.workspaceId}`)).json(),
  );
  if (checkpoint.state !== "failed" || checkpoint.ready_at || workspace.state === "preserved")
    throw new Error("Rejected capture published durable availability");
  await assertRecoverableSource(source, bytes);
  return {
    workspaceId: source.workspaceId,
    checkpointId: preserved.checkpoint.id,
    operationId: preserved.operation.id,
  };
}

export async function assertRecoverableSource(source: ReadyHarnessWorkspace, bytes: Buffer) {
  const name = `pocketcoder-ws-${source.workspaceId}`;
  const listed = await command(["docker", "ps", "-q", "--filter", `name=^/${name}$`], { quiet: true });
  if (!listed.stdout) throw new Error("Failed preserve destroyed the unpublished source");
  const inspect = JSON.parse((await command(["docker", "inspect", name], { quiet: true })).stdout)[0];
  if (inspect.HostConfig.Tmpfs?.["/work"] !== "rw,noexec,nosuid,nodev,size=1048576,uid=10001,gid=10001,mode=0700")
    throw new Error("Recoverable source lost its bounded private mount");
  const read = await command(
    [
      "docker",
      "exec",
      name,
      "bun",
      "-e",
      "console.log(Buffer.from(await Bun.file('/work/recoverable').arrayBuffer()).toString('base64'));",
    ],
    { quiet: true },
  );
  if (read.stdout !== bytes.toString("base64")) throw new Error("Failed preserve changed recoverable source bytes");
}

export async function cancelRecoverableSource(source: ReadyHarnessWorkspace) {
  const response = await source.request(`/v1/workspaces/${source.workspaceId}/cancel`, { method: "POST" });
  if (!response.ok) throw new Error(`Explicit source cancel refused: ${await response.text()}`);
  await waitFor(
    async () => {
      const row = WorkspaceResourceSchema.parse(
        await (await source.request(`/v1/workspaces/${source.workspaceId}`)).json(),
      );
      return row.state === "canceled";
    },
    30_000,
    "explicit recoverable source cancellation",
  );
  if (
    (
      await command(["docker", "ps", "-aq", "--filter", `name=^/pocketcoder-ws-${source.workspaceId}$`], {
        quiet: true,
      })
    ).stdout
  )
    throw new Error("Explicit cancellation retained source storage");
}
