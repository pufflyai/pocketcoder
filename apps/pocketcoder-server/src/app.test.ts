import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueEgressAuditToken } from "@pstdio/pocketcoder-auth";
import { PocketCoderClient } from "@pstdio/pocketcoder-client";
import type { WSContext } from "hono/ws";
import { Readiness } from "./health";
import {
	authed,
	createTestServer,
	SERVER_TEST_PEPPER as PEPPER,
	type TestServer,
} from "./test-server.test";

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

	test("propagates a bounded caller request ID on success and errors", async () => {
		const { app, token } = await createTestServer();
		const requestId = "caller-trace-123";
		const success = await app.request(
			"/v1/templates",
			authed(token, { headers: { "x-request-id": requestId } }),
		);
		expect(success.headers.get("x-request-id")).toBe(requestId);

		const failure = await app.request("/v1/templates", {
			headers: { "x-request-id": requestId },
		});
		expect(failure.headers.get("x-request-id")).toBe(requestId);
		expect(((await failure.json()) as { error: { request_id: string } }).error.request_id).toBe(
			requestId,
		);
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

	test("default-issued keys inherit current principal scopes", async () => {
		const { app, store, token } = await createTestServer();
		expect((await app.request("/v1/templates", authed(token))).status).toBe(200);
		const principal = await store.getPrincipalByName("test-backend");
		if (!principal) throw new Error("expected test principal");
		await store.updatePrincipal(
			principal.id,
			principal.scopes.filter((scope) => scope !== "templates:read"),
			principal.templateNames,
		);
		expect((await app.request("/v1/templates", authed(token))).status).toBe(403);
	});
});

describe("health", () => {
	test("separates process liveness from dependency readiness", async () => {
		const { app } = await createTestServer();
		const live = await app.request("/livez");
		const ready = await app.request("/readyz");

		expect(live.status).toBe(200);
		expect(await live.json()).toMatchObject({ ok: true });
		expect(ready.status).toBe(200);
		expect(await ready.json()).toMatchObject({
			ok: true,
			checks: {
				database: "ok",
				schema: "ok",
				reconciliation: "ok",
				coordinator: "ok",
			},
		});
	});

	test("keeps liveness healthy while a failed dependency makes readiness unavailable", async () => {
		const readiness = new Readiness();
		readiness.set("reconciliation", "failed");
		const { app } = await createTestServer({}, readiness);

		expect((await app.request("/livez")).status).toBe(200);
		const ready = await app.request("/readyz");
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({
			ok: false,
			checks: { reconciliation: "failed" },
		});
	});
});

describe("templates", () => {
	test("lists only authorized templates", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request("/v1/templates", authed(token));
		const body = (await res.json()) as { items: Array<{ name: string }> };
		expect(body.items.map((i) => i.name)).toEqual(["fixture-echo", "fixture-terminal"]);
	});

	test("unauthorized template names look nonexistent", async () => {
		const { app, token } = await createTestServer();
		const res = await app.request("/v1/templates/fixture-sleep", authed(token));
		expect(res.status).toBe(404);
	});
});

describe("workspace network audits", () => {
	test("authenticates, deduplicates, redacts, paginates, and authorizes events", async () => {
		const server = await createTestServer();
		const createdResponse = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "idempotency-key": "network-audit" },
				body: createBody("network-audit"),
			}),
		);
		const workspace = (await createdResponse.json()) as { id: string };
		const auditToken = issueEgressAuditToken(PEPPER, {
			kind: "workspace",
			id: workspace.id,
			expiresAt: new Date(Date.now() + 60_000),
		});
		const sourceSession = randomUUID();
		const event = {
			source_seq: 1,
			occurred_at: new Date().toISOString(),
			decision: "allow",
			transport: "http",
			host: "github.com",
			port: 443,
			method: "GET",
			path: "/repos/pstdio/pocketcoder",
			matched_rule: "github.com",
			reason: "matched_rule",
		};
		const body = JSON.stringify({ source_session_id: sourceSession, events: [event] });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await server.app.request("/v1/internal/egress/events", {
				method: "POST",
				headers: { authorization: `Bearer ${auditToken}`, "content-type": "application/json" },
				body,
			});
			expect(response.status).toBe(202);
		}
		const page = await server.app.request(
			`/v1/workspaces/${workspace.id}/network-events?limit=1`,
			authed(server.token),
		);
		expect(page.status).toBe(200);
		const events = (await page.json()) as {
			items: Array<Record<string, unknown>>;
			next_cursor: string | null;
		};
		expect(events.items).toHaveLength(1);
		expect(events.items[0]).toMatchObject({ seq: 1, host: "github.com", path: event.path });
		expect(JSON.stringify(events)).not.toContain("authorization");
		expect(events.next_cursor).toBeNull();
		const forbidden = await server.app.request(
			`/v1/workspaces/${workspace.id}/network-events`,
			authed(server.limitedToken),
		);
		expect(forbidden.status).toBe(403);
	});

	test("rejects expired audit credentials", async () => {
		const server = await createTestServer();
		const token = issueEgressAuditToken(PEPPER, {
			kind: "workspace",
			id: randomUUID(),
			expiresAt: new Date(Date.now() - 1),
		});
		const response = await server.app.request("/v1/internal/egress/events", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(401);
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

	test("replays an existing workspace even after the queue becomes full", async () => {
		const { app, token } = await createTestServer({
			maxQueuedWorkspaces: 1,
			globalActiveWorkspaces: 0,
		});
		const body = createBody("retry-after-capacity");
		const first = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "retry-after-capacity" },
				body,
			}),
		);
		expect(first.status).toBe(201);
		const created = (await first.json()) as { id: string };

		const replay = await app.request(
			"/v1/workspaces",
			authed(token, {
				method: "POST",
				headers: { "idempotency-key": "retry-after-capacity" },
				body,
			}),
		);

		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { id: string }).id).toBe(created.id);
	});

	test("reserves queue capacity atomically across concurrent creates", async () => {
		const { app, token, store } = await createTestServer({
			maxQueuedWorkspaces: 1,
			globalActiveWorkspaces: 0,
		});
		const requests = ["concurrent-capacity-a", "concurrent-capacity-b"].map((id) =>
			app.request(
				"/v1/workspaces",
				authed(token, {
					method: "POST",
					headers: { "idempotency-key": id },
					body: createBody(id),
				}),
			),
		);

		const responses = await Promise.all(requests);

		expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
		expect(await store.countQueued()).toBe(1);
	});

	test("does not advertise a next page at an exact collection boundary", async () => {
		const { app, token } = await createTestServer({ globalActiveWorkspaces: 0 });
		for (const id of ["page-boundary-a", "page-boundary-b"]) {
			expect(
				(
					await app.request(
						"/v1/workspaces",
						authed(token, {
							method: "POST",
							headers: { "idempotency-key": id },
							body: createBody(id),
						}),
					)
				).status,
			).toBe(201);
		}

		const response = await app.request("/v1/workspaces?limit=2", authed(token));
		const page = (await response.json()) as { items: unknown[]; next_cursor: string | null };
		expect(page.items).toHaveLength(2);
		expect(page.next_cursor).toBeNull();
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
});

describe("workspace creation diagnostics", () => {
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

describe("historical conversations", () => {
	test("filters the principal-scoped session index by exact metadata and time", async () => {
		const server = await createTestServer({ globalActiveWorkspaces: 0 });
		for (const [id, user] of [
			["session-a", "user-1"],
			["session-b", "user-2"],
		] as const) {
			const response = await server.app.request(
				"/v1/workspaces",
				authed(server.token, {
					method: "POST",
					headers: { "idempotency-key": id },
					body: JSON.stringify({
						external_id: id,
						template: { name: "fixture-echo" },
						metadata: { product: "onefin", tenant: "tenant-7", user },
					}),
				}),
			);
			expect(response.status).toBe(201);
		}
		const metadata = encodeURIComponent(
			JSON.stringify({ product: "onefin", tenant: "tenant-7", user: "user-1" }),
		);
		const response = await server.app.request(
			`/v1/workspaces?metadata=${metadata}`,
			authed(server.token),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: Array<{ external_id: string }> };
		expect(body.items.map((item) => item.external_id)).toEqual(["session-a"]);

		const invalidRange = await server.app.request(
			`/v1/workspaces?created_after=${encodeURIComponent("2026-08-04T00:00:00.000Z")}&created_before=${encodeURIComponent("2026-08-03T00:00:00.000Z")}`,
			authed(server.token),
		);
		expect(invalidRange.status).toBe(400);
	});

	test("reads a terminal transcript with stable pages, deduplicates, and deletes content", async () => {
		const server = await createTestServer({ globalActiveWorkspaces: 0 });
		const createdResponse = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "idempotency-key": "history-1" },
				body: createBody("history-1"),
			}),
		);
		const workspace = (await createdResponse.json()) as { id: string };
		const occurredAt = new Date("2026-08-03T08:00:00.000Z");
		const first = await server.store.appendConversationMessage({
			workspaceId: workspace.id,
			messageId: "m-1",
			role: "user",
			content: "Fix the failing test",
			occurredAt,
			metadata: { provider: "agentapi" },
			createdAt: occurredAt,
		});
		const duplicate = await server.store.appendConversationMessage({
			workspaceId: workspace.id,
			messageId: "m-1",
			role: "user",
			content: "must not replace the first payload",
			occurredAt,
			metadata: {},
			createdAt: occurredAt,
		});
		expect(first.created).toBe(true);
		expect(duplicate.created).toBe(false);
		expect(duplicate.message.content).toBe("Fix the failing test");
		await server.store.appendConversationMessage({
			workspaceId: workspace.id,
			messageId: "m-2",
			role: "assistant",
			content: "Implemented the fix",
			occurredAt: new Date("2026-08-03T08:01:00.000Z"),
			metadata: {},
			createdAt: occurredAt,
		});
		await server.store.transition(workspace.id, {
			from: ["queued"],
			to: "canceled",
			reason: "canceled_by_caller",
			at: new Date(),
		});

		const page1 = await server.app.request(
			`/v1/workspaces/${workspace.id}/conversation?limit=1`,
			authed(server.token),
		);
		expect(page1.status).toBe(200);
		const firstPage = (await page1.json()) as {
			items: Array<{ message_id: string; content: string }>;
			next_cursor: string;
			retention: { status: string; expires_at: string };
		};
		expect(firstPage.items).toEqual([
			expect.objectContaining({ message_id: "m-1", content: "Fix the failing test" }),
		]);
		expect(typeof firstPage.next_cursor).toBe("string");
		expect(firstPage.next_cursor).not.toBe("1");
		expect(firstPage.retention.status).toBe("retained");

		const page2 = await server.app.request(
			`/v1/workspaces/${workspace.id}/conversation?cursor=${encodeURIComponent(firstPage.next_cursor)}&limit=1`,
			authed(server.token),
		);
		const secondPage = (await page2.json()) as {
			items: Array<{ message_id: string }>;
			next_cursor: string | null;
		};
		expect(secondPage.items[0]?.message_id).toBe("m-2");
		expect(secondPage.next_cursor).toBeNull();
		await server.store.setConversationExpiry(workspace.id, new Date(Date.now() - 1), new Date());
		const expired = await server.app.request(
			`/v1/workspaces/${workspace.id}/conversation`,
			authed(server.token),
		);
		expect(expired.status).toBe(410);
		expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
			"conversation.expired",
		);
		expect(await server.store.pruneExpiredConversations(new Date())).toBe(1);
		expect(await server.store.readConversation(workspace.id, 0, 10)).toEqual([]);

		const deleted = await server.app.request(
			`/v1/workspaces/${workspace.id}/conversation`,
			authed(server.token, { method: "DELETE" }),
		);
		expect(deleted.status).toBe(204);
		const afterDelete = await server.app.request(
			`/v1/workspaces/${workspace.id}/conversation`,
			authed(server.token),
		);
		expect(afterDelete.status).toBe(410);
		expect(((await afterDelete.json()) as { error: { code: string } }).error.code).toBe(
			"conversation.deleted",
		);
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

	test("offers a direct AgentAPI alias without exposing the service abstraction", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const { sent } = fakeAgent(server, id, (frame) => {
			server.hub.resolveRelay(server.hub.get(id) as never, {
				request_id: frame.payload.request_id,
				status: 200,
				headers: { "content-type": "application/json" },
				body_b64: Buffer.from(JSON.stringify({ status: "stable" })).toString("base64"),
			});
		});
		const res = await server.app.request(`/v1/workspaces/${id}/agent/status`, authed(server.token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "stable" });
		expect(
			sent.map((value) => JSON.parse(value) as { payload: { service: string; path: string } }),
		).toContainEqual(
			expect.objectContaining({
				payload: expect.objectContaining({ service: "agent", path: "/status" }),
			}),
		);
	});
});

function connectTerminalAgent(server: TestServer, workspaceId: string, protocolVersion: 3 | 4) {
	const connection = server.hub.attach(
		workspaceId,
		randomUUID(),
		1,
		{ send() {}, close() {} } as unknown as WSContext,
		protocolVersion,
	);
	connection.registered = true;
}

async function terminalWorkspace(
	server: TestServer,
	template: "fixture-echo" | "fixture-terminal",
) {
	const response = await server.app.request(
		"/v1/workspaces",
		authed(server.token, {
			method: "POST",
			headers: { "idempotency-key": randomUUID() },
			body: JSON.stringify({
				external_id: randomUUID(),
				template: { name: template },
			}),
		}),
	);
	expect(response.status).toBe(201);
	return (await response.json()) as { id: string };
}

async function readyTerminalWorkspace(
	server: TestServer,
	template: "fixture-echo" | "fixture-terminal",
) {
	const created = await terminalWorkspace(server, template);
	await server.scheduler.tick();
	const now = new Date();
	await server.store.transition(created.id, {
		from: ["provisioning"],
		to: "connected",
		at: now,
	});
	await server.store.transition(created.id, {
		from: ["connected"],
		to: "ready",
		at: now,
		patch: { readyAt: now, lastActivityAt: now },
	});
	return created.id;
}

describe("remote terminals", () => {
	test("holds scope, workspace-state, template, and protocol gates before upgrade", async () => {
		const server = await createTestServer();
		const pending = await terminalWorkspace(server, "fixture-terminal");
		const notReady = await server.app.request(
			`/v1/workspaces/${pending.id}/terminal`,
			authed(server.token),
		);
		expect(notReady.status).toBe(409);

		const withoutTerminal = await readyTerminalWorkspace(server, "fixture-echo");
		connectTerminalAgent(server, withoutTerminal, 4);
		const undeclared = await server.app.request(
			`/v1/workspaces/${withoutTerminal}/terminal`,
			authed(server.token),
		);
		expect(undeclared.status).toBe(422);
		expect(((await undeclared.json()) as { error: { code: string } }).error.code).toBe(
			"terminal.not_declared",
		);

		const oldProtocol = await readyTerminalWorkspace(server, "fixture-terminal");
		connectTerminalAgent(server, oldProtocol, 3);
		const unsupported = await server.app.request(
			`/v1/workspaces/${oldProtocol}/terminal`,
			authed(server.token),
		);
		expect(unsupported.status).toBe(426);

		const missingScope = await server.app.request(
			`/v1/workspaces/${oldProtocol}/terminal`,
			authed(server.limitedToken),
		);
		expect(missingScope.status).toBe(403);
	});

	test("returns principal-owned terminal session audit pages", async () => {
		const server = await createTestServer();
		const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
		const openedAt = new Date("2026-08-05T12:00:00.000Z");
		const session = await server.store.openTerminalSession(
			{ sessionId: randomUUID(), workspaceId, keyId: server.keyId, openedAt },
			2,
		);
		if (!session) throw new Error("expected terminal session");
		await server.store.closeTerminalSession(session.sessionId, {
			closedAt: new Date("2026-08-05T12:01:00.000Z"),
			closeReason: "exit",
			exitCode: 0,
			bytesIn: 5,
			bytesOut: 9,
		});

		const response = await server.app.request(
			`/v1/workspaces/${workspaceId}/terminal-sessions`,
			authed(server.token),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [
				{
					session_id: session.sessionId,
					close_reason: "exit",
					exit_code: 0,
					duration_ms: 60_000,
					bytes_in: 5,
					bytes_out: 9,
				},
			],
			next_cursor: null,
		});
	});

	test("rejects malformed reattach ids and enforces the audited session limit", async () => {
		const server = await createTestServer();
		const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
		connectTerminalAgent(server, workspaceId, 4);
		const upgrade = { upgrade: "websocket" };
		const malformed = await server.app.request(
			`/v1/workspaces/${workspaceId}/terminal?session=not-a-uuid`,
			authed(server.token, { headers: upgrade }),
		);
		expect(malformed.status).toBe(400);

		for (let index = 0; index < 2; index += 1) {
			expect(
				await server.store.openTerminalSession(
					{
						sessionId: randomUUID(),
						workspaceId,
						keyId: server.keyId,
						openedAt: new Date(),
					},
					2,
				),
			).not.toBeNull();
		}
		const limited = await server.app.request(
			`/v1/workspaces/${workspaceId}/terminal`,
			authed(server.token, { headers: upgrade }),
		);
		expect(limited.status).toBe(409);
		expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
			"terminal.session_limit",
		);
	});

	test("upgrades a terminal WebSocket and audits the live session", async () => {
		const server = await createTestServer();
		const workspaceId = await readyTerminalWorkspace(server, "fixture-terminal");
		let connection: ReturnType<TestServer["hub"]["attach"]>;
		const agentSocket = {
			send(value: string) {
				const frame = JSON.parse(value) as {
					type: string;
					payload: { session_id?: string; data_b64?: string };
				};
				if (!frame.payload.session_id) return;
				const sessionId = frame.payload.session_id;
				if (frame.type === "terminal_open") {
					queueMicrotask(() => server.hub.terminalOpened(connection, { session_id: sessionId }));
					return;
				}
				if (frame.type !== "terminal_input" || !frame.payload.data_b64) return;
				queueMicrotask(() => {
					server.hub.terminalOutput(connection, {
						session_id: sessionId,
						data_b64: frame.payload.data_b64 as string,
					});
					server.hub.terminalClosed(connection, {
						session_id: sessionId,
						reason: "exit",
						exit_code: 3,
					});
				});
			},
			close() {},
		} as unknown as WSContext;
		connection = server.hub.attach(workspaceId, randomUUID(), 1, agentSocket, 4);
		connection.registered = true;
		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: server.app.fetch,
			websocket: server.websocket,
		});
		try {
			const frames: Array<Record<string, unknown>> = [];
			const socket = new WebSocket(
				`ws://127.0.0.1:${listener.port}/v1/workspaces/${workspaceId}/terminal`,
				{ headers: { authorization: `Bearer ${server.token}` } } as unknown as string[],
			);
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("terminal WebSocket timed out")), 2000);
				socket.onerror = () => reject(new Error("terminal WebSocket failed"));
				socket.onclose = (event) =>
					reject(new Error(`terminal WebSocket closed (${event.code}): ${event.reason}`));
				socket.onmessage = (event) => {
					const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
					frames.push(frame);
					if (frame.type === "opened") {
						socket.send(
							JSON.stringify({
								type: "input",
								data_b64: Buffer.from("live-terminal").toString("base64"),
							}),
						);
					}
					if (frame.type !== "closed") return;
					clearTimeout(timeout);
					socket.onclose = null;
					socket.close();
					resolve();
				};
			});
			expect(frames).toEqual([
				expect.objectContaining({ type: "opened" }),
				{ type: "output", data_b64: Buffer.from("live-terminal").toString("base64") },
				expect.objectContaining({ type: "closed", reason: "exit", exit_code: 3 }),
			]);
			const sessionId = String(frames[0]?.session_id);
			const deadline = Date.now() + 1000;
			while (!(await server.store.getTerminalSession(sessionId))?.closedAt) {
				if (Date.now() > deadline) throw new Error("terminal audit did not close");
				await Bun.sleep(2);
			}
			expect(await server.store.getTerminalSession(sessionId)).toMatchObject({
				workspaceId,
				closeReason: "exit",
				exitCode: 3,
				bytesIn: 13,
				bytesOut: 13,
			});
			const eventTypes = (await server.store.claimDueEvents(new Date(Date.now() + 1000), 100)).map(
				(event) => event.eventType,
			);
			expect(eventTypes).toEqual(
				expect.arrayContaining(["workspace.terminal_opened", "workspace.terminal_closed"]),
			);
		} finally {
			await listener.stop(true);
		}
	}, 5000);
});

describe("openapi", () => {
	test("serves the generated document", async () => {
		const { app } = await createTestServer();
		const res = await app.request("/v1/openapi.json");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as {
			paths: Record<
				string,
				{
					get?: {
						operationId?: string;
						tags?: string[];
						parameters?: Array<{ name: string; in: string; required?: boolean }>;
						responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
					};
					post?: {
						operationId?: string;
						tags?: string[];
						parameters?: Array<{ name: string; in: string; required?: boolean }>;
						responses: Record<string, unknown>;
					};
					put?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
					patch?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
					delete?: { operationId?: string; tags?: string[]; responses: Record<string, unknown> };
				}
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
		for (const path of [
			"/v1/templates",
			"/v1/workspaces",
			"/v1/workspaces/{id}/checkpoints",
			"/v1/workspaces/{id}/conversation",
			"/v1/workspaces/{id}/outputs",
			"/v1/workspaces/{id}/network-events",
			"/v1/workspaces/{id}/logs",
		]) {
			const queryNames =
				doc.paths[path]?.get?.parameters
					?.filter((parameter) => parameter.in === "query")
					.map((parameter) => parameter.name) ?? [];
			expect(queryNames).toContain("cursor");
			expect(queryNames).not.toContain("after");
		}
		for (const path of Object.values(doc.paths)) {
			for (const operation of [path.get, path.post, path.put, path.patch, path.delete]) {
				if (!operation) continue;
				expect(operation.operationId).toBeString();
				expect(operation.tags?.length).toBeGreaterThan(0);
				for (const status of ["400", "401", "403"]) {
					expect(operation.responses).toHaveProperty(status);
				}
			}
		}
	});
});

describe("typed client conformance", () => {
	test("validates real Hono responses without a parallel DTO layer", async () => {
		const server = await createTestServer({ globalActiveWorkspaces: 0 });
		const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
			server.app.request(input, init)) as typeof fetch;
		const client = new PocketCoderClient(
			{ baseUrl: "http://pocketcoder.test", apiKey: server.token },
			fetchImpl,
		);

		const templates = await client.templates.list();
		expect(templates.map((template) => template.name)).toContain("fixture-echo");
		const created = await client.workspaces.create({
			externalId: "client-conformance",
			templateName: "fixture-echo",
		});
		expect((await client.workspaces.get(created.id)).external_id).toBe("client-conformance");
	});
});
