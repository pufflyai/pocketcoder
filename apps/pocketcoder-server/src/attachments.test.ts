import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import {
	ATTACHMENT_CHUNK_BYTES,
	ATTACHMENT_MAX_FILE_BYTES,
	type AttachmentDescriptor,
	type ProtocolVersion,
} from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS, type Store } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import type { WSContext } from "hono/ws";
import { type BuiltServer, buildServer } from "./app";

const PEPPER = "attachment-pepper";

interface TestServer extends BuiltServer {
	store: Store;
	token: string;
	relayOnlyToken: string;
}

async function createTestServer(): Promise<TestServer> {
	const store = new MemoryStore();
	const driver = new FakeDriver();
	const principal = await store.createPrincipal(
		"attachment-backend",
		[
			"workspaces:create",
			"workspaces:read",
			"workspaces:cancel",
			"services:relay",
			"attachments:write",
		],
		["fixture-echo"],
	);
	const key = issueMachineKey(PEPPER);
	await store.insertMachineKey({
		id: key.id,
		principalId: principal.id,
		secretDigest: key.secretDigest,
		scopes: [],
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	// The same principal, but through a key that lacks attachments:write.
	const relayOnly = issueMachineKey(PEPPER);
	await store.insertMachineKey({
		id: relayOnly.id,
		principalId: principal.id,
		secretDigest: relayOnly.secretDigest,
		scopes: ["workspaces:create", "workspaces:read", "services:relay"],
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	const parsed = fixtureTemplateEcho();
	await store.upsertTemplate({
		name: parsed.manifest.metadata.name,
		version: parsed.manifest.spec.version,
		digest: parsed.digest,
		description: null,
		spec: parsed.manifest.spec,
	});
	const built = buildServer({
		store,
		driver,
		pepper: PEPPER,
		limits: DEFAULT_LIMITS,
		workspaceServerUrl: "http://127.0.0.1:0",
	});
	return { ...built, store, token: key.token, relayOnlyToken: relayOnly.token };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
	};
}

async function readyWorkspace(server: TestServer): Promise<string> {
	const res = await server.app.request(
		"/v1/workspaces",
		authed(server.token, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
			body: JSON.stringify({ external_id: randomUUID(), template: { name: "fixture-echo" } }),
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

interface FakeUpload {
	attachmentId: string;
	name: string;
	mediaType: string;
	declared: number;
	received: Buffer[];
}

// An in-memory stand-in for the supervisor's attachment manager, driven by
// the frames the hub sends over the (fake) socket.
function fakeAgent(server: TestServer, workspaceId: string, protocolVersion: ProtocolVersion = 3) {
	const stored = new Map<string, AttachmentDescriptor>();
	const ops = new Map<string, FakeUpload>();
	const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const proxied: Array<{ path: string; body: unknown }> = [];
	const connId = randomUUID();

	const finishUpload = (
		conn: NonNullable<ReturnType<TestServer["hub"]["get"]>>,
		op: FakeUpload,
		operationId: string,
	) => {
		const bytes = Buffer.concat(op.received);
		const descriptor: AttachmentDescriptor = {
			id: op.attachmentId,
			name: op.name,
			path: `/home/pocketcoder/.pcd/attachments/${op.attachmentId}/${op.name}`,
			media_type: op.mediaType,
			size_bytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
		const existing = stored.get(op.attachmentId);
		if (!existing) stored.set(op.attachmentId, descriptor);
		const identical = existing?.sha256 === descriptor.sha256;
		server.hub.pushAttachment(conn, {
			kind: "result",
			payload: {
				operation_id: operationId,
				status: existing ? (identical ? "existing" : "conflict") : "created",
				descriptor: existing && identical ? existing : descriptor,
			},
		});
	};

	const respond = (frame: { type: string; payload: Record<string, unknown> }) => {
		const conn = server.hub.get(workspaceId);
		if (!conn) return;
		const payload = frame.payload;
		const operationId = payload.operation_id as string;
		const op = ops.get(operationId);
		switch (frame.type) {
			case "attachment_start":
				ops.set(operationId, {
					attachmentId: payload.attachment_id as string,
					name: payload.name as string,
					mediaType: payload.media_type as string,
					declared: payload.size_bytes as number,
					received: [],
				});
				return;
			case "attachment_chunk": {
				if (!op) return;
				op.received.push(Buffer.from(payload.content_b64 as string, "base64"));
				server.hub.pushAttachment(conn, {
					kind: "ack",
					payload: {
						operation_id: operationId,
						seq: payload.seq as number,
						received_bytes: Buffer.concat(op.received).byteLength,
					},
				});
				return;
			}
			case "attachment_finish":
				if (op) finishUpload(conn, op, operationId);
				return;
			case "attachment_resolve": {
				const ids = payload.attachment_ids as string[];
				const missing = ids.find((id) => !stored.has(id));
				server.hub.pushAttachment(conn, {
					kind: "resolved",
					payload: missing
						? { operation_id: operationId, missing_id: missing }
						: {
								operation_id: operationId,
								descriptors: ids.map((id) => stored.get(id) as AttachmentDescriptor),
							},
				});
				return;
			}
			case "proxy_request": {
				proxied.push({
					path: payload.path as string,
					body: payload.body_b64
						? JSON.parse(Buffer.from(payload.body_b64 as string, "base64").toString("utf8"))
						: undefined,
				});
				server.hub.resolveRelay(conn, {
					request_id: payload.request_id as string,
					status: 200,
					headers: { "content-type": "application/json" },
					body_b64: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
				});
				return;
			}
		}
	};

	const ws = {
		send: (data: string) => {
			const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
			frames.push(frame);
			queueMicrotask(() => respond(frame));
		},
		close: () => {},
	} as unknown as WSContext;
	const conn = server.hub.attach(workspaceId, connId, 1, ws, protocolVersion);
	conn.registered = true;
	return { conn, stored, frames, proxied };
}

function uploadRequest(
	token: string,
	bytes: Uint8Array,
	overrides: Record<string, string> = {},
): RequestInit {
	return authed(token, {
		method: "PUT",
		headers: {
			"content-type": "text/plain",
			"content-disposition": 'attachment; filename="notes.txt"',
			"content-length": String(bytes.byteLength),
			...overrides,
		},
		body: bytes,
	});
}

describe("attachment upload", () => {
	test("streams chunked frames through the supervisor and returns the descriptor", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const agent = fakeAgent(server, id);
		const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1024).fill(7);
		const attachmentId = randomUUID();

		const res = await server.app.request(
			`/v1/workspaces/${id}/attachments/${attachmentId}`,
			uploadRequest(server.token, bytes),
		);
		expect(res.status).toBe(201);
		const descriptor = (await res.json()) as AttachmentDescriptor;
		expect(descriptor).toMatchObject({
			id: attachmentId,
			name: "notes.txt",
			media_type: "text/plain",
			size_bytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(descriptor.path).toContain(attachmentId);

		const types = agent.frames.map((frame) => frame.type);
		expect(types).toEqual([
			"attachment_start",
			"attachment_chunk",
			"attachment_chunk",
			"attachment_finish",
		]);
	});

	test("byte-identical retries return 200 and different bytes conflict with 409", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id);
		const attachmentId = randomUUID();
		const bytes = new TextEncoder().encode("stable bytes");

		const first = await server.app.request(
			`/v1/workspaces/${id}/attachments/${attachmentId}`,
			uploadRequest(server.token, bytes),
		);
		expect(first.status).toBe(201);
		const retry = await server.app.request(
			`/v1/workspaces/${id}/attachments/${attachmentId}`,
			uploadRequest(server.token, bytes),
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual(await first.json());

		const conflicting = await server.app.request(
			`/v1/workspaces/${id}/attachments/${attachmentId}`,
			uploadRequest(server.token, new TextEncoder().encode("other bytes")),
		);
		expect(conflicting.status).toBe(409);
		expect(((await conflicting.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.conflict",
		);
	});

	test("requires the attachments:write scope", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id);
		const res = await server.app.request(
			`/v1/workspaces/${id}/attachments/${randomUUID()}`,
			uploadRequest(server.relayOnlyToken, new Uint8Array(1)),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"auth.missing_scope",
		);
	});

	test("rejects invalid ids, missing filenames, and oversized declarations", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id);

		const badId = await server.app.request(
			`/v1/workspaces/${id}/attachments/not-a-uuid`,
			uploadRequest(server.token, new Uint8Array(1)),
		);
		expect(badId.status).toBe(400);
		expect(((await badId.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.invalid",
		);

		const noName = await server.app.request(
			`/v1/workspaces/${id}/attachments/${randomUUID()}`,
			authed(server.token, {
				method: "PUT",
				headers: { "content-type": "text/plain", "content-length": "1" },
				body: new Uint8Array(1),
			}),
		);
		expect(noName.status).toBe(400);

		const huge = await server.app.request(
			`/v1/workspaces/${id}/attachments/${randomUUID()}`,
			uploadRequest(server.token, new Uint8Array(ATTACHMENT_MAX_FILE_BYTES + 1)),
		);
		expect(huge.status).toBe(413);
		expect(((await huge.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.too_large",
		);
	});

	test("rejects uploads while the workspace is not ready, ended, or disconnected", async () => {
		const server = await createTestServer();
		const res = await server.app.request(
			"/v1/workspaces",
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": "gates" },
				body: JSON.stringify({ external_id: "gates", template: { name: "fixture-echo" } }),
			}),
		);
		const ws = (await res.json()) as { id: string };
		const notReady = await server.app.request(
			`/v1/workspaces/${ws.id}/attachments/${randomUUID()}`,
			uploadRequest(server.token, new Uint8Array(1)),
		);
		expect(notReady.status).toBe(409);

		const readyId = await readyWorkspace(server);
		const disconnected = await server.app.request(
			`/v1/workspaces/${readyId}/attachments/${randomUUID()}`,
			uploadRequest(server.token, new Uint8Array(1)),
		);
		expect(disconnected.status).toBe(503);

		await server.app.request(
			`/v1/workspaces/${ws.id}/cancel`,
			authed(server.token, { method: "POST" }),
		);
		const terminal = await server.app.request(
			`/v1/workspaces/${ws.id}/attachments/${randomUUID()}`,
			uploadRequest(server.token, new Uint8Array(1)),
		);
		expect(terminal.status).toBe(410);
	});

	test("rejects uploads to supervisors that predate protocol v3", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id, 2);
		const res = await server.app.request(
			`/v1/workspaces/${id}/attachments/${randomUUID()}`,
			uploadRequest(server.token, new Uint8Array(1)),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.unsupported",
		);
	});
});

describe("agent message attachments", () => {
	async function uploaded(server: TestServer, id: string): Promise<string> {
		const attachmentId = randomUUID();
		const res = await server.app.request(
			`/v1/workspaces/${id}/attachments/${attachmentId}`,
			uploadRequest(server.token, new TextEncoder().encode("attachment body")),
		);
		expect(res.status).toBe(201);
		return attachmentId;
	}

	for (const alias of ["agent", "services/agent"]) {
		test(`appends the manifest and strips ids through /${alias}/message`, async () => {
			const server = await createTestServer();
			const id = await readyWorkspace(server);
			const agent = fakeAgent(server, id);
			const attachmentId = await uploaded(server, id);

			const res = await server.app.request(
				`/v1/workspaces/${id}/${alias}/message`,
				authed(server.token, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "user",
						content: "Summarize the attachment.",
						attachment_ids: [attachmentId],
					}),
				}),
			);
			expect(res.status).toBe(200);
			const message = agent.proxied.find((request) => request.path === "/message");
			expect(message).toBeDefined();
			const body = message?.body as { content: string; attachment_ids?: unknown };
			expect(body.attachment_ids).toBeUndefined();
			expect(body.content).toStartWith("Summarize the attachment.");
			expect(body.content).toContain("<pocketcoder-attachments>");
			expect(body.content).toContain(
				`/home/pocketcoder/.pcd/attachments/${attachmentId}/notes.txt`,
			);
		});
	}

	test("keeps text-only messages byte-identical", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const agent = fakeAgent(server, id);
		const res = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "user", content: "plain text" }),
			}),
		);
		expect(res.status).toBe(200);
		expect(agent.proxied[0]?.body).toEqual({ type: "user", content: "plain text" });
	});

	test("rejects unknown attachment ids without sending anything to the agent", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const agent = fakeAgent(server, id);
		const res = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "user", content: "x", attachment_ids: [randomUUID()] }),
			}),
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.not_found",
		);
		expect(agent.proxied).toEqual([]);
	});

	test("rejects messages whose resolved attachments exceed the aggregate limit", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const agent = fakeAgent(server, id);
		const ids = Array.from({ length: 5 }, () => randomUUID());
		for (const attachmentId of ids) {
			agent.stored.set(attachmentId, {
				id: attachmentId,
				name: "big.bin",
				path: `/home/pocketcoder/.pcd/attachments/${attachmentId}/big.bin`,
				media_type: "application/octet-stream",
				size_bytes: ATTACHMENT_MAX_FILE_BYTES,
				sha256: "a".repeat(64),
			});
		}
		const res = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "user", content: "x", attachment_ids: ids }),
			}),
		);
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.too_large",
		);
		expect(agent.proxied).toEqual([]);
	});

	test("rejects duplicate ids as invalid", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		fakeAgent(server, id);
		const attachmentId = randomUUID();
		const res = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "user",
					content: "x",
					attachment_ids: [attachmentId, attachmentId],
				}),
			}),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.invalid",
		);
	});

	test("rejects attachment messages for supervisors that predate protocol v3", async () => {
		const server = await createTestServer();
		const id = await readyWorkspace(server);
		const agent = fakeAgent(server, id, 2);
		const res = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "user", content: "x", attachment_ids: [randomUUID()] }),
			}),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"attachment.unsupported",
		);

		// Text-only relay keeps working for the same connection.
		const plain = await server.app.request(
			`/v1/workspaces/${id}/agent/message`,
			authed(server.token, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "user", content: "still works" }),
			}),
		);
		expect(plain.status).toBe(200);
		expect(agent.proxied[0]?.body).toEqual({ type: "user", content: "still works" });
	});
});
