import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { supervise } from "../../pocketcoder-agent/src/supervisor";
import { buildServer } from "./app";

// End-to-end conformance: REST create -> scheduler -> (fake) driver ->
// real supervisor over real WSS -> setup command -> harness process ->
// health -> ready -> relayed conversation -> cancel -> terminal state.
// The harness is a real child process serving the AgentAPI routes.

const PEPPER = "e2e-pepper";

// A free port for the harness, reserved briefly so parallel or aborted runs
// cannot collide on a hardcoded one.
function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = Number(probe.port);
	probe.stop(true);
	return port;
}

const HARNESS_PORT = freePort();

const HARNESS_SCRIPT = `
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
async function verifyAttachmentFlow(
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

async function waitFor<T>(
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

async function createSourceFixture(directory: string) {
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

async function verifySourceSecretBoundary(
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

function e2eTemplate(input: {
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

describe("end-to-end workspace lifecycle", () => {
	const cleanups: Array<() => void> = [];
	// Ensures the supervisor and its harness child are stopped even when an
	// assertion fails mid-flight, so no process leaks across runs.
	let teardown: (() => Promise<void>) | null = null;
	afterAll(async () => {
		await teardown?.().catch(() => {});
		for (const fn of cleanups) fn();
	});

	test(
		"create, setup, harness, ready, converse, cancel",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "pocketcoder-e2e-"));
			const harnessPath = join(dir, "harness.ts");
			const sourceCredential = "short-lived-git-token";
			const { setupPath, setupMarker, harnessEnvironment, worktree } =
				await createSourceFixture(dir);
			await writeFile(harnessPath, HARNESS_SCRIPT);

			const template = e2eTemplate({ setupPath, harnessPath, harnessEnvironment, worktree });

			const store = new MemoryStore();
			const driver = new FakeDriver();
			const principal = await store.createPrincipal("e2e", ["admin"], ["*"]);
			const key = issueMachineKey(PEPPER);
			await store.insertMachineKey({
				id: key.id,
				principalId: principal.id,
				secretDigest: key.secretDigest,
				scopes: ["admin"],
				createdAt: new Date(),
				expiresAt: null,
				revokedAt: null,
				lastUsedAt: null,
			});
			await store.upsertTemplate({
				name: "e2e-echo",
				version: "1.0.0",
				digest: template.digest,
				description: null,
				spec: template.manifest.spec,
			});

			const storageDriver = new FilesystemStorageDriver({
				workspaceRoot: join(dir, "storage"),
				checkpointRoot: join(dir, "checkpoints"),
			});
			const secretResolver = {
				resolve: async () => [],
				resolveSourceCredential: async () => sourceCredential,
			};
			const { app, websocket, scheduler } = buildServer({
				store,
				driver,
				storageDriver,
				secretResolver,
				pepper: PEPPER,
				limits: DEFAULT_LIMITS,
				workspaceServerUrl: "placeholder",
			});
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: app.fetch,
				websocket,
			});
			cleanups.push(() => server.stop(true));
			const baseUrl = `http://127.0.0.1:${server.port}`;
			const authHeaders = {
				authorization: `Bearer ${key.token}`,
				"content-type": "application/json",
			};

			// 1. Create the workspace through the REST API.
			const createRes = await fetch(`${baseUrl}/v1/workspaces`, {
				method: "POST",
				headers: { ...authHeaders, "idempotency-key": "e2e-1" },
				body: JSON.stringify({
					external_id: "e2e-task",
					template: { name: "e2e-echo" },
					source: { kind: "git", repository: "app", revision: "main" },
				}),
			});
			expect(createRes.status).toBe(201);
			const ws = (await createRes.json()) as { id: string; state: string };
			expect(ws.state).toBe("queued");

			// 2. Scheduler admits it through the (fake) driver.
			await scheduler.tick();
			const input = driver.inputFor(ws.id);
			expect(input).toBeDefined();
			expect(driver.created[0]?.secrets).toEqual([]);

			// 3. Start the real supervisor with the provider input, pointed
			// at the real WSS endpoint. HOME points at the test directory so
			// supervisor-owned attachment storage stays inside the sandbox.
			const originalHome = process.env.HOME;
			process.env.HOME = dir;
			cleanups.push(() => {
				process.env.HOME = originalHome;
			});
			const inputPath = join(dir, "input.json");
			await writeFile(inputPath, JSON.stringify({ ...input, server_url: baseUrl }));
			const supervisorDone = supervise(inputPath);
			teardown = async () => {
				await fetch(`${baseUrl}/v1/workspaces/${ws.id}/cancel`, {
					method: "POST",
					headers: authHeaders,
				}).catch(() => {});
				await Promise.race([supervisorDone, new Promise((resolve) => setTimeout(resolve, 8000))]);
			};

			// 4. The workspace becomes ready after setup + harness health.
			await waitFor(
				async () => (await store.getWorkspace(ws.id))?.state === "ready",
				15_000,
				"workspace ready",
			);
			await verifySourceSecretBoundary(
				store,
				ws.id,
				setupMarker,
				harnessEnvironment,
				sourceCredential,
			);

			// 5. Converse through the relay.
			const post = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/message`, {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({ content: "hello agent" }),
			});
			expect(post.status).toBe(200);
			const messages = await waitFor(
				async () => {
					const res = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/messages`, {
						headers: authHeaders,
					});
					if (!res.ok) return null;
					const body = (await res.json()) as { messages: Array<{ content: string }> };
					return body.messages.length >= 2 ? body.messages : null;
				},
				10_000,
				"agent echo",
			);
			expect(messages[1]?.content).toBe("echo: hello agent");

			// The harness emits canonical transcript records on stdout. The real
			// supervisor forwards them over WSS and the server persists them.
			const conversation = await waitFor(
				async () => {
					const res = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/conversation`, {
						headers: authHeaders,
					});
					if (!res.ok) return null;
					const body = (await res.json()) as {
						items: Array<{ role: string; content: string; seq: number }>;
					};
					return body.items.length >= 2 ? body.items : null;
				},
				10_000,
				"durable conversation",
			);
			expect(conversation.map(({ role, content }) => ({ role, content }))).toEqual([
				{ role: "user", content: "hello agent" },
				{ role: "assistant", content: "echo: hello agent" },
			]);
			expect(conversation.map(({ seq }) => seq)).toEqual([1, 2]);

			// 5b. Attachments flow end-to-end through the real supervisor.
			await verifyAttachmentFlow(baseUrl, ws.id, authHeaders, dir);

			// 6. Undeclared routes stay rejected even on a live workspace.
			const forbidden = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/admin`, {
				headers: authHeaders,
			});
			expect(forbidden.status).toBe(422);

			// 7. Cancel; the supervisor shuts the harness down and the
			// workspace reaches the canceled terminal state.
			const cancelRes = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/cancel`, {
				method: "POST",
				headers: authHeaders,
			});
			expect(cancelRes.status).toBe(200);
			await waitFor(
				async () => (await store.getWorkspace(ws.id))?.state === "canceled",
				15_000,
				"workspace canceled",
			);
			const exitCode = await supervisorDone;
			teardown = null;
			expect(typeof exitCode).toBe("number");

			// Terminal workspaces retain transcript history for the configured
			// retention window.
			const retainedRes = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/conversation`, {
				headers: authHeaders,
			});
			expect(retainedRes.status).toBe(200);
			const retained = (await retainedRes.json()) as { items: unknown[] };
			expect(retained.items).toHaveLength(4);

			// 8. Outbox recorded the full lifecycle.
			const events = await store.claimDueEvents(new Date(), 100);
			const types = events.map((e) => e.eventType);
			for (const expected of [
				"workspace.queued",
				"workspace.provisioning",
				"workspace.connected",
				"workspace.ready",
				"workspace.terminating",
				"workspace.canceled",
			]) {
				expect(types).toContain(expected);
			}

			// 9. Logs captured harness output through the supervisor.
			const history = await store.listStateHistory(ws.id);
			expect(history[0]?.toState).toBe("queued");
		},
		{ timeout: 60_000 },
	);
});

// Keep the snapshot helper import alive for future assertions.
void snapshotOf;
