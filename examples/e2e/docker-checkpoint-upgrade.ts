import { randomUUID } from "node:crypto";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { checkpointSourceFixture } from "./checkpoint-source-fixture";
import { command, waitFor } from "./local-process";

// Preserves a Docker workspace on template version A, publishes a compatible version B
// with more memory, and restores the checkpoint onto B. The restored container must run
// B's resources and keep A's saved files.
const fixture = await checkpointSourceFixture();
try {
  const source = await fixture.createSource();
  const { request } = source;
  const container = (id: string) => `pocketcoder-ws-${id}`;
  await command(["docker", "exec", container(source.workspaceId), "sh", "-c", "echo saved-on-a > /work/known"], {
    quiet: true,
  });
  const preserved = PreserveResponseSchema.parse(
    await (
      await request(`/v1/workspaces/${source.workspaceId}/preserve`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: "{}",
      })
    ).json(),
  );
  async function settled(id: string) {
    await waitFor(
      async () => {
        const row = OperationResourceSchema.parse(await (await request(`/v1/operations/${id}`)).json());
        if (row.state === "failed") throw new Error(`Operation failed: ${row.reason_code}`);
        return row.state === "succeeded";
      },
      30_000,
      "checkpoint operation",
    );
  }
  await settled(preserved.operation.id);

  const upgraded = structuredClone(fixture.manifest);
  upgraded.spec.version = "1.1.0";
  upgraded.spec.resources = { ...upgraded.spec.resources, memory: "512Mi" };
  const published = await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest: upgraded }) });
  if (published.status !== 201) throw new Error(`Template publish refused: ${await published.text()}`);

  const response = await request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ external_id: randomUUID(), template_version: "1.1.0" }),
  });
  if (!response.ok) throw new Error(`Upgrade restore refused: ${await response.text()}`);
  const restored = RestoreResponseSchema.parse(await response.json());
  fixture.ownWorkspace(restored.workspace.id);
  await settled(restored.operation.id);
  const workspace = WorkspaceResourceSchema.parse(
    await (await request(`/v1/workspaces/${restored.workspace.id}`)).json(),
  );
  if (workspace.state !== "ready" || workspace.template.version !== "1.1.0")
    throw new Error(`Upgraded workspace is ${workspace.state} on ${workspace.template.version}`);
  const memory = await command(
    ["docker", "inspect", "--format", "{{.HostConfig.Memory}}", container(restored.workspace.id)],
    { quiet: true },
  );
  if (memory.stdout.trim() !== String(512 * 1024 * 1024))
    throw new Error(`Upgraded container memory is ${memory.stdout.trim()}`);
  const read = await command(["docker", "exec", container(restored.workspace.id), "cat", "/work/known"], {
    quiet: true,
  });
  if (read.stdout.trim() !== "saved-on-a") throw new Error("Upgraded restore lost the saved file");
  await request(`/v1/workspaces/${restored.workspace.id}/cancel`, { method: "POST" });
  console.log(
    JSON.stringify({
      result: "passed",
      checkpointId: preserved.checkpoint.id,
      destinationId: restored.workspace.id,
      templateVersion: workspace.template.version,
      memoryBytes: Number(memory.stdout.trim()),
    }),
  );
} finally {
  await fixture.dispose();
}
