import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import type { MemoryStore } from "@pstdio/pocketcoder-memory-store";

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
import { randomUUID } from "node:crypto";
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

// Uploads an attachment through the streaming API: the real supervisor
// stores it under $HOME/.pcd/attachments, an identical retry is idempotent,
// and a message referencing the ID reaches the harness with the generated
// manifest and no attachment_ids.
export async function verifyAttachmentFlow(
  baseUrl: string,
  workspaceId: string,
  authHeaders: Record<string, string>,
  home: string,
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
    },
    body: payload,
  };
  const uploadUrl = `${baseUrl}/v1/workspaces/${workspaceId}/attachments/${attachmentId}`;
  const uploaded = await fetch(uploadUrl, uploadInit);
  expect(uploaded.status).toBe(201);
  const descriptor = (await uploaded.json()) as { path: string; sha256: string };
  expect(descriptor.path).toBe(join(home, ".pcd", "attachments", attachmentId, "notes.txt"));
  expect(await Bun.file(descriptor.path).text()).toBe(payload);

  const retried = await fetch(uploadUrl, uploadInit);
  expect(retried.status).toBe(200);
  expect(((await retried.json()) as { sha256: string }).sha256).toBe(descriptor.sha256);

  const attached = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/agent/message`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      type: "user",
      content: "read the attachment",
      attachment_ids: [attachmentId],
    }),
  });
  expect(attached.status).toBe(200);
  const manifestMessage = await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/services/agent/messages`, {
        headers: authHeaders,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { messages: Array<{ content: string }> };
      return body.messages.find((m) => m.content.includes("<pocketcoder-attachments>"));
    },
    10_000,
    "manifest-bearing message",
  );
  expect(manifestMessage.content).toContain(descriptor.path);
  expect(manifestMessage.content).not.toContain("attachment_ids");
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/conversation`, {
        headers: authHeaders,
      });
      if (!res.ok) return null;
      return ((await res.json()) as { items: unknown[] }).items.length >= 4;
    },
    10_000,
    "attachment turn in the durable conversation",
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
  store: MemoryStore,
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
            credential: "secretRef:git/token",
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
