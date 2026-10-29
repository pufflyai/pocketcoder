import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseStore } from "@pstdio/pocketcoder-db";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

// A preserved workspace whose template declares chat transcripts in its harness-state mount.
async function preserved(state: "canceled" | "ready" = "canceled") {
  const store = (await createStore()) as DatabaseStore;
  const server = await createTestServer(store, { globalActiveWorkspaces: 0 });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": "artifact" },
      body: createTestBody("artifact"),
    }),
  );
  const { id } = (await created.json()) as { id: string };
  const artifacts = [
    { name: "chat-transcripts", mount: "harness-state", pattern: "chats/*/transcript.jsonl", maxBytes: 64 },
  ];
  await store.context.sql.query(
    `UPDATE pocketcoder.workspaces SET template_snapshot = jsonb_set(jsonb_set(template_snapshot,
      '{spec,persistence,artifacts}', CAST($1 AS text)::jsonb), '{spec,persistence,mounts}', CAST($2 AS text)::jsonb) WHERE id = $3`,
    [
      JSON.stringify(artifacts),
      JSON.stringify([{ name: "harness-state", target: "/var/state", maxBytes: 1024, maxFiles: 10 }]),
      id,
    ],
  );
  if (state === "canceled")
    await store.transition(id, { from: ["queued"], to: "canceled", reason: "canceled_by_caller", at: new Date() });
  const workspace = await store.getWorkspace(id);
  if (!workspace) throw new Error("workspace missing");
  const root = await mkdtemp(join(tmpdir(), "pc-artifact-checkpoint-"));
  await mkdir(join(root, "harness-state/chats/chat-1"), { recursive: true });
  await writeFile(join(root, "harness-state/chats/chat-1/transcript.jsonl"), '{"tool":"read"}\n');
  await mkdir(join(root, "harness-state/chats/large"), { recursive: true });
  await writeFile(join(root, "harness-state/chats/large/transcript.jsonl"), "x".repeat(65));
  await symlink("/etc", join(root, "harness-state/chats/escape"));
  const at = new Date();
  const storageId = randomUUID();
  await store.insertWorkspaceStorage({
    id: storageId,
    workspaceId: id,
    principalId: workspace.principalId,
    providerKind: "filesystem",
    providerRef: { kind: "filesystem", root },
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
  await store.insertCheckpoint({
    id: randomUUID(),
    workspaceId: id,
    principalId: workspace.principalId,
    storageId,
    parentCheckpointId: null,
    state: "ready",
    reasonCode: null,
    providerKind: "filesystem",
    providerRef: { kind: "filesystem", id: "checkpoint", root },
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
  const read = (path: string) => server.app.request(`/v1/workspaces/${id}/artifacts/${path}`, authed(server.token));
  return { read, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a preserved workspace serves a declared artifact without resuming", async () => {
  const { read, cleanup } = await preserved();
  try {
    const response = await read("chat-transcripts?key=chat-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe('{"tool":"read"}\n');
  } finally {
    await cleanup();
  }
});

test("unknown names, keys outside the pattern, links and missing files are not found", async () => {
  const { read, cleanup } = await preserved();
  try {
    for (const path of [
      "unknown?key=chat-1",
      "undeclared-mount?key=chat-1",
      "chat-transcripts",
      "chat-transcripts?key=..",
      "chat-transcripts?key=escape",
      "chat-transcripts?key=missing",
    ]) {
      const response = await read(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toMatchObject({ error: { code: "artifact.not_found" } });
    }
    const large = await read("chat-transcripts?key=large");
    expect(large.status).toBe(413);
  } finally {
    await cleanup();
  }
});

test("a running workspace points callers to its live relay", async () => {
  const { read, cleanup } = await preserved("ready");
  try {
    const response = await read("chat-transcripts?key=chat-1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "artifact.workspace_active" } });
  } finally {
    await cleanup();
  }
});
