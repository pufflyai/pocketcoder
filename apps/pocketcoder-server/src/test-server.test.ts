import { issueMachineKey } from "@pstdio/pocketcoder-auth";
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
