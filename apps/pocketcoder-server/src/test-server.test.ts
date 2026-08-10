import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import {
	HEADER_PROTOCOL,
	HEADER_REGISTRATION,
	HEADER_WORKSPACE,
	PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS, type Store } from "@pstdio/pocketcoder-runtime-core";
import {
	FakeDriver,
	fixtureTemplateEcho,
	fixtureTemplateSleep,
	fixtureTemplateTerminal,
} from "@pstdio/pocketcoder-testkit";
import { type BuiltServer, buildServer } from "./app";
import type { Readiness } from "./health";

export const SERVER_TEST_PEPPER = "test-pepper";

export interface TestServer extends BuiltServer {
	store: Store;
	driver: FakeDriver;
	token: string;
	keyId: string;
	limitedToken: string;
}

export async function createTestServer(limits = {}, readiness?: Readiness): Promise<TestServer> {
	const store = new MemoryStore();
	const driver = new FakeDriver();
	const principal = await store.createPrincipal(
		"test-backend",
		[
			"templates:read",
			"workspaces:create",
			"workspaces:read",
			"workspaces:cancel",
			"workspaces:restore",
			"conversations:read",
			"conversations:delete",
			"services:relay",
			"logs:read",
			"network:read",
			"terminal:attach",
			"terminal:read",
		],
		["fixture-echo", "fixture-terminal"],
	);
	const key = issueMachineKey(SERVER_TEST_PEPPER);
	await store.insertMachineKey({
		id: key.id,
		principalId: principal.id,
		secretDigest: key.secretDigest,
		// An empty key scope set means the key inherits the principal's live scopes.
		scopes: [],
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	const limitedPrincipal = await store.createPrincipal("read-only", ["templates:read"], ["*"]);
	const limitedKey = issueMachineKey(SERVER_TEST_PEPPER);
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
	for (const parsed of [fixtureTemplateEcho(), fixtureTemplateSleep(), fixtureTemplateTerminal()]) {
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
		pepper: SERVER_TEST_PEPPER,
		limits: { ...DEFAULT_LIMITS, ...limits },
		workspaceServerUrl: "http://127.0.0.1:0",
		...(readiness ? { readiness } : {}),
	});
	return {
		...built,
		store,
		driver,
		token: key.token,
		keyId: key.id,
		limitedToken: limitedKey.token,
	};
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	};
}

export async function markReadyThroughAgent(
	testServer: Pick<TestServer, "app" | "websocket" | "store" | "driver">,
	workspaceId: string,
): Promise<void> {
	const input = testServer.driver.inputFor(workspaceId);
	if (!input) throw new Error("expected provider input");
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: testServer.app.fetch,
		websocket: testServer.websocket,
	});
	const connectionId = randomUUID();
	const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/v1/agent/connect`, {
		headers: {
			[HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
			[HEADER_WORKSPACE]: workspaceId,
			[HEADER_REGISTRATION]: input.registration_secret,
		},
	} as unknown as string[]);
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("agent registration timed out")), 2000);
			const fail = (message: string) => {
				clearTimeout(timeout);
				reject(new Error(message));
			};
			socket.onerror = () => fail("agent registration failed");
			socket.onopen = () => {
				socket.send(
					JSON.stringify({
						v: PROTOCOL_VERSION,
						type: "registered",
						workspace_id: workspaceId,
						connection_id: connectionId,
						seq: 0,
						sent_at: new Date().toISOString(),
						payload: {
							agent_version: "test",
							template: {
								name: input.template_name,
								version: input.template_version,
								digest: input.template_digest,
							},
							services: ["agent"],
							pid: 1,
						},
					}),
				);
			};
			socket.onmessage = (event) => {
				const frame = JSON.parse(String(event.data)) as { type: string };
				if (frame.type !== "registered_ack") return;
				socket.send(
					JSON.stringify({
						v: PROTOCOL_VERSION,
						type: "service_health",
						workspace_id: workspaceId,
						connection_id: connectionId,
						seq: 1,
						sent_at: new Date().toISOString(),
						payload: { service: "agent", health: "healthy" },
					}),
				);
				clearTimeout(timeout);
				resolve();
			};
		});
		const deadline = Date.now() + 5000;
		while ((await testServer.store.getWorkspace(workspaceId))?.state !== "ready") {
			if (Date.now() >= deadline) throw new Error("workspace readiness timed out");
			await Bun.sleep(20);
		}
	} finally {
		socket.close();
		await listener.stop(true);
	}
}
