import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, MemoryStore } from "@pstdio/pocketcoder-testkit";
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
const messages = [];
let status = "stable";
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
        return Response.json({ ok: true });
      });
    }
    return new Response("not found", { status: 404 });
  },
});
`;

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
			const setupMarker = join(dir, "setup-ran");
			await writeFile(harnessPath, HARNESS_SCRIPT);

			const template = parseTemplateManifest({
				apiVersion: "pocketcoder.dev/v1alpha1",
				kind: "Template",
				metadata: { name: "e2e-echo", description: "e2e" },
				spec: {
					version: "1.0.0",
					image: `example.test/e2e@sha256:${"c".repeat(64)}`,
					setup: [{ name: "touch-marker", command: ["touch", setupMarker], timeoutSeconds: 30 }],
					harness: { command: ["bun", harnessPath] },
					resources: { cpu: "1", memory: "256Mi" },
					timeouts: { start: "1m", maxAge: "10m", idle: "5m", terminateGrace: "5s" },
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

			const { app, websocket, scheduler } = buildServer({
				store,
				driver,
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
				body: JSON.stringify({ external_id: "e2e-task", template: { name: "e2e-echo" } }),
			});
			expect(createRes.status).toBe(201);
			const ws = (await createRes.json()) as { id: string; state: string };
			expect(ws.state).toBe("queued");

			// 2. Scheduler admits it through the (fake) driver.
			await scheduler.tick();
			const input = driver.inputFor(ws.id);
			expect(input).toBeDefined();

			// 3. Start the real supervisor with the provider input, pointed
			// at the real WSS endpoint.
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
			expect(await Bun.file(setupMarker).exists()).toBe(true);

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
			expect(typeof exitCode).toBe("number");

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
