import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { server, waitFor } from "./persistence-support.test";

export async function failedAllocation() {
  const app = await server({ retainFailures: true });
  const response = await app.request("/v1/workspaces", {
    method: "POST",
    headers: { "idempotency-key": "purge-source" },
    body: JSON.stringify({ external_id: "purge-source", template: { name: "fixture-persistent" } }),
  });
  expect(response.status).toBe(201);
  const workspace = (await response.json()) as { id: string };
  await app.scheduler.tick();
  await waitFor(async () => (await app.store.getWorkspaceStorage(workspace.id))?.state === "ready");
  const storage = await app.store.getWorkspaceStorage(workspace.id);
  if (!storage) throw new Error("missing allocation");
  const marker = join(String(storage.providerRef.root), "worktree", "marker.txt");
  await writeFile(marker, "synthetic retained content");
  const now = new Date();
  await app.store.appendLogs(workspace.id, [
    { stream: "stdout", occurredAt: now, content: new TextEncoder().encode("synthetic log") },
  ]);
  await app.store.appendOutput({
    workspaceId: workspace.id,
    seq: 0,
    name: "result",
    value: "synthetic output",
    occurredAt: now,
  });
  await app.store.appendConversationMessage({
    workspaceId: workspace.id,
    messageId: "message",
    role: "user",
    content: "synthetic transcript",
    metadata: {},
    occurredAt: now,
    createdAt: now,
  });
  const row = await app.store.getWorkspace(workspace.id);
  if (!row) throw new Error("missing workspace");
  await app.scheduler.fail(row, "child_exit_failure", now);
  await waitFor(async () => (await app.store.getWorkspace(workspace.id))?.state === "failed");
  expect(await readFile(marker, "utf8")).toBe("synthetic retained content");
  const purge = (key = "purge-request", id = workspace.id) =>
    app.request(`/v1/workspaces/${id}/purge`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: "{}",
    });
  return { ...app, workspace, storage, marker, purge };
}
