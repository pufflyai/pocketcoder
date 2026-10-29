import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type InputObjectReference, parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";

// A free port for the harness, reserved briefly so parallel or aborted runs
// cannot collide on a hardcoded one.
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

const HARNESS_PORT = freePort();

export const HARNESS_SCRIPT = `
import { createHash, randomUUID } from "node:crypto";
if (process.env.HARNESS_ENV_PATH) {
  await Bun.write(process.env.HARNESS_ENV_PATH, JSON.stringify({
    source: process.env.POCKETCODER_SOURCE ?? null,
    environment: process.env,
  }));
}
const messages = [];
let status = "stable";
function emitConversation(role, content) {
  console.log("POCKETCODER_CONVERSATION " + JSON.stringify({
    message_id: randomUUID(),
    role,
    content,
    occurred_at: new Date().toISOString(),
    metadata: { source: "e2e-harness" },
  }));
}
Bun.serve({
  hostname: "127.0.0.1",
  port: ${HARNESS_PORT},
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({ status });
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      return Response.json({ messages });
    }
    if (req.method === "POST" && url.pathname === "/message") {
      return req.json().then((body) => {
        messages.push({ role: "user", content: body.content });
        messages.push({ role: "agent", content: "echo: " + body.content });
        emitConversation("user", body.content);
        emitConversation("assistant", "echo: " + body.content);
        return Response.json({ ok: true });
      });
    }
    return new Response("not found", { status: 404 });
  },
});
`;

// Real HTTP staging must leave workload files outside canonical authority.
export async function verifyAttachmentFlow(
  baseUrl: string,
  workspaceId: string,
  authHeaders: Record<string, string>,
  home: string,
  root: string,
  store: Store,
): Promise<void> {
  const attachmentId = randomUUID();
  const payload = "attachment payload for e2e";
  const uploadInit = {
    method: "PUT",
    headers: {
      authorization: authHeaders.authorization as string,
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="notes.txt"',
      "content-length": String(payload.length),
      "x-content-sha256": createHash("sha256").update(payload).digest("hex"),
    },
    body: payload,
  };
  const uploadUrl = `${baseUrl}/v1/workspaces/${workspaceId}/attachments/${attachmentId}`;
  const uploaded = await fetch(uploadUrl, uploadInit);
  expect(uploaded.status).toBe(201);
  const reference = (await uploaded.json()) as InputObjectReference;
  expect(reference).toMatchObject({ workspaceId, fileId: attachmentId, visibility: "ready" });
  expect(reference).not.toHaveProperty("path");
  const row = await store.inputs.get(workspaceId, attachmentId);
  if (!row) throw new Error("Expected a durable input descriptor.");
  const canonical = join(root, workspaceId, attachmentId, row.reservationId, "payload");
  expect(await Bun.file(canonical).text()).toBe(payload);
  const workloadDirectory = join(home, ".pcd", "attachments", attachmentId);
  expect(await Bun.file(join(workloadDirectory, "notes.txt")).exists()).toBe(false);
  await mkdir(workloadDirectory, { recursive: true });
  await writeFile(join(workloadDirectory, "notes.txt"), "forged workload bytes");
  await writeFile(join(workloadDirectory, ".metadata.json"), JSON.stringify({ sha256: "forged" }));
  const retried = await fetch(uploadUrl, uploadInit);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual(reference);
  expect(await Bun.file(canonical).text()).toBe(payload);

  const attached = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/agent/message`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ type: "user", content: "read the attachment", attachment_ids: [attachmentId] }),
  });
  expect(attached.status).toBe(409);
  expect(await attached.json()).toMatchObject({ error: { code: "attachment.unsupported" } });
  const messages = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/services/agent/messages`, {
    headers: authHeaders,
  });
  expect((await messages.json()) as unknown).toMatchObject({
    messages: [
      { role: "user", content: "hello agent" },
      { role: "agent", content: "echo: hello agent" },
    ],
  });
  const plain = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/agent/message`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ type: "user", content: "plain followup" }),
  });
  expect(plain.status).toBe(200);
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/conversation`, { headers: authHeaders });
      return ((await res.json()) as { items: unknown[] }).items.length === 4;
    },
    10_000,
    "plain followup in durable conversation",
  );
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function createSourceFixture(directory: string) {
  const setupPath = join(directory, "setup.ts");
  const setupMarker = join(directory, "setup-ran");
  const harnessEnvironment = join(directory, "harness-environment.json");
  const worktree = join(directory, "worktree");
  await writeFile(
    setupPath,
    `import { mkdir } from "node:fs/promises";
const source = JSON.parse(process.env.POCKETCODER_SOURCE ?? "null");
if (!source || typeof source.credential !== "string") throw new Error("missing source credential");
console.error("clone credential: " + source.credential);
await mkdir(source.destination, { recursive: true });
await Bun.write(source.destination + "/README.md", "fixture\\n");
const commands = [
  ["git", "init", "-q", source.destination],
  ["git", "-C", source.destination, "add", "README.md"],
  ["git", "-C", source.destination, "-c", "user.name=PocketCoder", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
];
for (const command of commands) {
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
await Bun.write(${JSON.stringify(setupMarker)}, JSON.stringify({
  credential_received: true,
  credential_path: source.credential_path ?? null,
}));
`,
  );
  return { setupPath, setupMarker, harnessEnvironment, worktree };
}

export async function verifySourceSecretBoundary(
  store: Store,
  workspaceId: string,
  setupMarker: string,
  harnessEnvironment: string,
  sourceCredential: string,
) {
  expect(JSON.parse(await Bun.file(setupMarker).text())).toEqual({
    credential_received: true,
    credential_path: null,
  });
  expect(await Bun.file(harnessEnvironment).text()).not.toContain(sourceCredential);
  const logs = await store.readLogs(workspaceId, 0, 100);
  const logText = logs.map((entry) => new TextDecoder().decode(entry.content)).join("");
  expect(logText).toContain("clone credential: [redacted]");
  expect(logText).not.toContain(sourceCredential);
}

export function e2eTemplate(input: {
  setupPath: string;
  harnessPath: string;
  harnessEnvironment: string;
  worktree: string;
}) {
  return parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "e2e-echo", description: "e2e" },
    spec: {
      version: "1.0.0",
      image: `example.test/e2e@sha256:${"c".repeat(64)}`,
      setup: [{ name: "clone-source", command: ["bun", input.setupPath], timeoutSeconds: 30 }],
      harness: {
        command: ["bun", input.harnessPath],
        env: { HARNESS_ENV_PATH: input.harnessEnvironment },
      },
      resources: { cpu: "1", memory: "256Mi" },
      timeouts: { start: "1m", maxAge: "10m", idle: "5m", terminateGrace: "5s" },
      security: { writableMemoryPaths: [] },
      persistence: {
        mounts: [{ name: "worktree", target: input.worktree, maxBytes: 1_048_576, maxFiles: 100 }],
      },
      source: {
        kind: "git",
        destinationMount: "worktree",
        repositories: {
          app: {
            url: "https://github.com/example/app.git",
            credential: "secretRef:git-clone",
          },
        },
      },
      services: {
        agent: {
          baseUrl: `http://127.0.0.1:${HARNESS_PORT}`,
          healthPath: "/status",
          routes: [
            { method: "GET", path: "/status" },
            { method: "GET", path: "/messages", query: ["after"] },
            { method: "POST", path: "/message" },
          ],
        },
      },
    },
  });
}
