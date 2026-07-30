import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { DEFAULT_LIMITS, type Store } from "@pstdio/pocketcoder-runtime-core";
import {
	FakeDriver,
	fixtureTemplateEcho,
	fixtureTemplateSleep,
	MemoryStore,
} from "@pstdio/pocketcoder-testkit";
import type { WSContext } from "hono/ws";
import { type BuiltServer, buildServer } from "./app";

const PEPPER = "test-pepper";

interface TestServer extends BuiltServer {
	store: Store;
	driver: FakeDriver;
	token: string;
	limitedToken: string;
}

async function createTestServer(limits = {}): Promise<TestServer> {
	const store = new MemoryStore();
	const driver = new FakeDriver();
	const principal = await store.createPrincipal(
		"test-backend",
		[
			"templates:read",
			"workspaces:create",
			"workspaces:read",
			"workspaces:cancel",
			"services:relay",
			"logs:read",
		],
		["fixture-echo"],
	);
	const key = issueMachineKey(PEPPER);
	await store.insertMachineKey({
		id: key.id,
		principalId: principal.id,
		secretDigest: key.secretDigest,
		scopes: principal.scopes,
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	const limitedPrincipal = await store.createPrincipal("read-only", ["templates:read"], ["*"]);
	const limitedKey = issueMachineKey(PEPPER);
	await store.insertMachineKey({
		id: limitedKey.id,
		principalId: limitedPrincipal.id,
		secretDigest: limitedKey.secretDigest,
		scopes: limitedPrincipal.scopes,
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	for (const parsed of [fixtureTemplateEcho(), fixtureTemplateSleep()]) {
		await store.upsertTemplate({
			name: parsed.manifest.metadata.name,
			version: parsed.manifest.spec.version,
			digest: parsed.digest,
			description: parsed.manifest.metadata.description ?? null,
			spec: parsed.manifest.spec,
		});
	}
	const built = buildServer({
		store,
		driver,
		pepper: PEPPER,
		limits: { ...DEFAULT_LIMITS, ...limits },
		workspaceServerUrl: "http://127.0.0.1:0",
	});
	return { ...built, store, driver, token: key.token, limitedToken: limitedKey.token };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	};
}

function createBody(externalId: string = randomUUID()) {
	return JSON.stringify({
		external_id: externalId,
		template: { name: "fixture-echo" },
		launch_input: { bootstrap_code: "opaque" },
	});
}

describe("authentication", () => {
	test("rejects missing and invalid keys with the stable envelope", async () => {
		const { app } = await createTestServer();
		const res = await app.request("/v1/templates");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string; request_id: string } };
		expect(body.error.code).toBe("auth.invalid_key");
		expect(body.error.request_id.length).toBeGreaterThan(0);

		const res2 = await app.request("/v1/templates", authed("pkt_bad_token"));
		expect(res2.status).toBe(401);
	});

	test("rejects revoked keys on the next request", async () => {
		const { app, store, token } = await createTestServer();
		const keyId = token.split("_")[1] as string;
		expect((await app.request("/v1/templates", authed(token))).status).toBe(200);
		await store.revokeMachineKey(keyId, new Date());
		expect((await app.request("/v1/templates", authed(token))).status).toBe(401);
	});

	test("enforces scopes", async () => {
		const { app, limitedToken } = await createTestServer();
		const res = await app.request(
			"/v1/workspaces",
			authed(limitedToken, {
				method: "POST",
				headers: { "idempotency-key": "k1" },
				body: createBody(),
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("auth.missing_scope");
	});
});

describe("templates", () => {
	test("lists only authorized templates", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request("/v1/templates", authed(token));
		const body = (await res.json()) as { items: Array<{ name: string }> };
		expect(body.items.map((i) => i.name)).toEqual(["fixture-echo"]);
	});

	test("unauthorized template names look nonexistent", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request("/v1/templates/fixture-sleep", authed(token));
		expect(res.status).toBe(404);
	});
});

describe("workspace creation", () => {
	test("creates queued workspace and is idempotent on the same key and body", async () => {
		const { app, token } = await createTestServer();
		const body = createBody("task-1");
		const first = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", headers: { "idempotency-key": "idem-1" }, body }),
		);
		expect(first.status).toBe(201);
		const created = (await first.json()) as {
			id: string;
			state: string;
			template: { digest: string };
		};
		expect(created.state).toBe("queued");
		expect(created.template.digest.startsWith("sha256:")).toBe(true);
		expect((created as { change_cursor?: number }).change_cursor).toBe(1);
		expect((created as { agent_state?: string }).agent_state).toBe("unknown");
		expect((created as { failure?: unknown }).failure).toBeNull();

		const repeat = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", headers: { "idempotency-key": "idem-1" }, body }),
		);
		expect(repeat.status).toBe(200);
		expect(((await repeat.json()) as { id: string }).id).toBe(created.id);
	});

	test("conflicting body under the same idempotency key returns 409", async () => {
		const { app, token } = await createTestServer();
		await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "idem-2" },
				body: createBody("task-a"),
			}),
		);
		const res = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "idem-2" },
				body: createBody("task-b"),
			}),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"idempotency.conflict",
		);
	});

	test("missing Idempotency-Key is a validation error", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", body: createBody() }),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
			"Idempotency-Key header is required.",
		);
	});

	test("long-polls a durable workspace change cursor", async () => {
		const { app, store, token } = await createTestServer({ globalActiveWorkspaces: 0 });
		const createdRes = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "changes-1" },
				body: createBody("changes-1"),
			}),
		);
		const created = (await createdRes.json()) as { id: string; change_cursor: number };
		const noChange = await app.request(
			`/v1/workspaces/${created.id}/changes?after=${created.change_cursor}&wait=0`,
			authed(token),
		);
		expect(noChange.status).toBe(200);
		expect((await noChange.json()) as unknown).toMatchObject({
			cursor: created.change_cursor,
			changed: false,
		});

		const waitUrl = `/v1/workspaces/${created.id}/changes?after=${created.change_cursor}&wait=1`;
		const waiting = [
			app.request(waitUrl, authed(token)),
			app.request(waitUrl, authed(token)),
		] as const;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await store.transition(created.id, {
			from: ["queued"],
			to: "canceled",
			reason: "canceled_by_caller",
			at: new Date(),
		});
		const [changed, secondChanged] = await Promise.all(waiting);
		expect(changed.status).toBe(200);
		expect(secondChanged.status).toBe(200);
		const body = (await changed.json()) as {
			cursor: number;
			changed: boolean;
			workspace: { state: string; change_cursor: number };
		};
		expect(body.changed).toBe(true);
		expect(body.cursor).toBeGreaterThan(created.change_cursor);
		expect(body.workspace.state).toBe("canceled");
		expect(body.workspace.change_cursor).toBe(body.cursor);
		expect((await secondChanged.json()) as unknown).toMatchObject({
			cursor: body.cursor,
			changed: true,
			workspace: { state: "canceled" },
		});
	});

	test("returns a bounded log tail with a failed workspace", async () => {
		const server = await createTestServer();
		const createdRes = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "idempotency-key": "failure-tail-1" },
				body: createBody("failure-tail-1"),
			}),
		);
		const created = (await createdRes.json()) as { id: string };
		await server.scheduler.tick();
		const row = await server.store.getWorkspace(created.id);
		expect(row).not.toBeNull();
		await server.store.appendLogs(created.id, [
			{
				stream: "stderr",
				occurredAt: new Date(),
				content: new TextEncoder().encode(`${"x".repeat(17_000)}\n`),
			},
			{
				stream: "stderr",
				occurredAt: new Date(),
				content: new TextEncoder().encode(
					"Authorization: Bearer should-not-leak\nTraceback (most recent call last):\nPermissionError: /home/onefin/.pi\n",
				),
			},
		]);
		await server.scheduler.fail(row as NonNullable<typeof row>, "child_exit_failure", new Date());

		const response = await server.app.request(`/v1/workspaces/${created.id}`, authed(server.token));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			failure: {
				reason_code: string;
				log_tail: string;
				log_tail_truncated: boolean;
				last_log_seq: number;
			};
		};
		expect(body.failure.reason_code).toBe("child_exit_failure");
		expect(body.failure.log_tail).toContain("PermissionError: /home/onefin/.pi");
		expect(body.failure.log_tail).not.toContain("should-not-leak");
		expect(body.failure.log_tail).toContain("[redacted]");
		expect(body.failure.log_tail_truncated).toBe(true);
		expect(body.failure.last_log_seq).toBe(2);
	});

	test("unauthorized template returns 403, unknown 404, full queue 429", async () => {
		// globalActiveWorkspaces: 0 keeps admission from draining the queue
		// so the queue-full path is deterministic.
		const { app, token } = await createTestServer({
			maxQueuedWorkspaces: 1,
			globalActiveWorkspaces: 0,
		});
		const sleepBody = JSON.stringify({ external_id: "t", template: { name: "fixture-sleep" } });
		const forbidden = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", headers: { "idempotency-key": "k1" }, body: sleepBody }),
		);
		expect(forbidden.status).toBe(403);

		const unknown = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "k2" },
				body: JSON.stringify({ external_id: "t2", template: { name: "fixture-echo" } }),
			}),
		);
		expect(unknown.status).toBe(201);

		const overflow = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", headers: { "idempotency-key": "k3" }, body: createBody() }),
		);
		expect(overflow.status).toBe(429);
	});

	test("oversized launch_input is rejected by the template limit", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "big" },
				body: JSON.stringify({
					external_id: "big",
					template: { name: "fixture-echo" },
					launch_input: { blob: "x".repeat(70_000) },
				}),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("workspace lifecycle API", () => {
	test("get, list, and idempotent cancel", async () => {
		const { app, token, store } = await createTestServer();
		const res = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "c1" },
				body: createBody("cancel-me"),
			}),
		);
		const ws = (await res.json()) as { id: string };

		const got = await app.request(`/v1/workspaces/${ws.id}`, authed(token));
		expect(got.status).toBe(200);

		const list = await app.request("/v1/workspaces?external_id=cancel-me", authed(token));
		const listBody = (await list.json()) as { items: Array<{ id: string }> };
		expect(listBody.items.map((i) => i.id)).toContain(ws.id);

		// The scheduler may already have admitted the workspace, so the first
		// cancel can return the transient `terminating` state; it must settle
		// at `canceled`.
		const cancel1 = await app.request(
			`/v1/workspaces/${ws.id}/cancel`,
			authed(token, { method: "POST" }),
		);
		expect(cancel1.status).toBe(200);
		expect(["terminating", "canceled"]).toContain(
			((await cancel1.json()) as { state: string }).state,
		);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && (await store.getWorkspace(ws.id))?.state !== "canceled") {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect((await store.getWorkspace(ws.id))?.state).toBe("canceled");

		const cancel2 = await app.request(
			`/v1/workspaces/${ws.id}/cancel`,
			authed(token, { method: "POST" }),
		);
		expect(cancel2.status).toBe(200);
		expect(((await cancel2.json()) as { state: string }).state).toBe("canceled");

		const row = await store.getWorkspace(ws.id);
		expect(row?.reasonCode).toBe("canceled_by_caller");
	});

	test("other principals cannot see the workspace", async () => {
		const { app, token, limitedToken } = await createTestServer();
		const res = await app.request(
			"/v1/workspaces",
			authed(token, { method: "POST", headers: { "idempotency-key": "p1" }, body: createBody() }),
		);
		const ws = (await res.json()) as { id: string };
		const other = await app.request(`/v1/workspaces/${ws.id}`, authed(limitedToken));
		expect(other.status).toBe(403); // read-only principal lacks workspaces:read
	});
});

describe("service relay", () => {
	async function readyWorkspace(server: TestServer) {
		const res = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "idempotency-key": randomUUID() },
				body: createBody(),
			}),
		);
		const ws = (await res.json()) as { id: string };
		await server.scheduler.tick();
		const now = new Date();
		await server.store.transition(ws.id, { from: ["provisioning"], to: "connected", at: now });
		await server.store.transition(ws.id, {
			from: ["connected"],
			to: "ready",
			at: now,
			patch: { readyAt: now, lastActivityAt: now },
		});
		return ws.id;
	}

	function fakeAgent(
		server: TestServer,
		workspaceId: string,
		respond: (frame: { payload: { request_id: string; path: string } }) => void,
	) {
		const sent: string[] = [];
		const ws = {
			send: (data: string) => {
				sent.push(data);
				const frame = JSON.parse(data) as {
					type: string;
					payload: { request_id: string; path: string };
				};
				if (frame.type === "proxy_request") queueMicrotask(() => respond(frame));
			},
			close: () => {},
		} as unknown as WSContext;
		const conn = server.hub.attach(workspaceId, randomUUID(), 1, ws);
		conn.registered = true;
		return { conn, sent };
	}

	test("workspace not ready returns 409; terminal returns 410", async () => {
		const server = await createTestServer();
		const res = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "idempotency-key": "r1" },
				body: createBody(),
			}),
		);
		const ws = (await res.json()) as { id: string };
		const notReady = await server.app.request(
			`/v1/workspaces/${ws.id}/services/agent/status`,
			authed(server.token),
		);
		expect(notReady.status).toBe(409);

		await server.app.request(
			`/v1/workspaces/${ws.id}/cancel`,
			authed(server.token, { method: "POST" }),
		);
		const terminal = await server.app.request(
			`/v1/workspaces/${ws.id}/services/agent/status`,
			authed(server.token),
		);
		expect(terminal.status).toBe(410);
	});

	test("ready but disconnected returns 503", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const res = await server.app.request(
			`/v1/workspaces/${id}/services/agent/status`,
			authed(server.token),
		);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"workspace.disconnected",
		);
	});

	test("undeclared routes and query fields are rejected with 422", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id, () => {});
		const badRoute = await server.app.request(
			`/v1/workspaces/${id}/services/agent/shell`,
			authed(server.token),
		);
		expect(badRoute.status).toBe(422);

		const badMethod = await server.app.request(
			`/v1/workspaces/${id}/services/agent/status`,
			authed(server.token, { method: "DELETE" }),
		);
		expect(badMethod.status).toBe(422);

		const badQuery = await server.app.request(
			`/v1/workspaces/${id}/services/agent/status?redirect=http://evil`,
			authed(server.token),
		);
		expect(badQuery.status).toBe(422);
	});

	test("oversized request body returns 413", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id, () => {});
		const res = await server.app.request(
			`/v1/workspaces/${id}/services/agent/message`,
			authed(server.token, {
				method: "POST",
				body: JSON.stringify({ content: "x".repeat(70_000) }),
			}),
		);
		expect(res.status).toBe(413);
	});

	test("relays a declared route through the live connection", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id, (frame) => {
			server.hub.resolveRelay(server.hub.get(id) as never, {
				request_id: frame.payload.request_id,
				status: 200,
				headers: { "content-type": "application/json" },
				body_b64: Buffer.from(JSON.stringify({ status: "stable" })).toString("base64"),
			});
		});
		const res = await server.app.request(
			`/v1/workspaces/${id}/services/agent/status`,
			authed(server.token),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "stable" });
	});
});

describe("openapi", () => {
	test("serves the generated document", async () => {
		const { app } = await createTestServer();
		const res = await app.request("/v1/openapi.json");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as {
			paths: Record<
				string,
				{ post?: { parameters?: Array<{ name: string; in: string; required?: boolean }> } }
			>;
		};
		expect(Object.keys(doc.paths)).toContain("/v1/workspaces");
		expect(Object.keys(doc.paths)).toContain("/v1/templates");
		expect(doc.paths["/v1/workspaces"]?.post?.parameters).toContainEqual(
			expect.objectContaining({
				name: "Idempotency-Key",
				in: "header",
				required: true,
			}),
		);
	});
});
