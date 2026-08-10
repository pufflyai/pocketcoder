import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { migrate, PostgresStore } from "@pstdio/pocketcoder-db";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { SQL } from "bun";
import { buildServer } from "./app";
import { DEFAULT_PERSISTENCE_LIMITS } from "./persistence";

const databaseUrl = process.env.POCKETCODER_TEST_DATABASE_URL;
const pepper = "postgres-route-test-pepper";

async function waitFor(condition: () => Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition timed out");
}

async function removeStorageRoot(root: string) {
	async function makeWritable(path: string): Promise<void> {
		await chmod(path, 0o700).catch(() => {});
		const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await makeWritable(child);
			else await chmod(child, 0o600).catch(() => {});
		}
	}

	await makeWritable(root);
	await rm(root, { recursive: true, force: true });
}

describe.skipIf(!databaseUrl)("PostgreSQL persistence routes", () => {
	test("preserve and restore keep operation foreign-key targets valid", async () => {
		const schema = `pkt_routes_${randomUUID().slice(0, 8)}`;
		const sql = new SQL(databaseUrl as string);
		const root = await mkdtemp(join(tmpdir(), "pocketcoder-postgres-routes-"));
		const store = new PostgresStore(databaseUrl as string, schema);

		try {
			await migrate(sql, schema);
			await store.init();
			const constraints = (await sql.unsafe(
				`SELECT constraint_name FROM information_schema.table_constraints
				 WHERE constraint_schema = $1 AND table_name = 'workspace_operations'
				 AND constraint_type = 'FOREIGN KEY'`,
				[schema],
			)) as Array<{ constraint_name: string }>;
			expect(constraints.map((row) => row.constraint_name)).toEqual(
				expect.arrayContaining([
					"workspace_operations_fBJ1lkBRI011_fkey",
					"workspace_operations_result_workspace_id_workspaces_id_fkey",
				]),
			);

			const parsed = fixtureTemplatePersistent();
			await store.upsertTemplate({
				name: parsed.manifest.metadata.name,
				version: parsed.manifest.spec.version,
				digest: parsed.digest,
				description: parsed.manifest.metadata.description ?? null,
				spec: parsed.manifest.spec,
			});
			const principal = await store.createPrincipal("postgres-route-user", ["admin"], ["*"]);
			const key = issueMachineKey(pepper);
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

			const driver = new FakeDriver();
			const storageDriver = new FilesystemStorageDriver({
				workspaceRoot: join(root, "workspaces"),
				checkpointRoot: join(root, "checkpoints"),
			});
			const server = buildServer({
				store,
				driver,
				storageDriver,
				pepper,
				limits: DEFAULT_LIMITS,
				persistenceLimits: DEFAULT_PERSISTENCE_LIMITS,
				workspaceServerUrl: "http://127.0.0.1:0",
			});
			const request = (path: string, init: RequestInit = {}) =>
				server.app.request(path, {
					...init,
					headers: {
						authorization: `Bearer ${key.token}`,
						"content-type": "application/json",
						...(init.headers ?? {}),
					},
				});

			const createResponse = await request("/v1/workspaces", {
				method: "POST",
				headers: { "idempotency-key": "postgres-create" },
				body: JSON.stringify({
					external_id: "postgres-source",
					template: { name: "fixture-persistent" },
				}),
			});
			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as { id: string };
			await server.scheduler.tick();
			await waitFor(async () => (await store.getWorkspaceStorage(created.id))?.state === "ready");
			const now = new Date();
			await store.transition(created.id, { from: ["provisioning"], to: "connected", at: now });
			await store.transition(created.id, {
				from: ["connected"],
				to: "ready",
				at: now,
				patch: { readyAt: now, lastActivityAt: now },
			});
			const sourceStorage = await store.getWorkspaceStorage(created.id);
			const sourceRoot = String(sourceStorage?.providerRef.root);
			await mkdir(join(sourceRoot, "worktree"), { recursive: true });
			await writeFile(join(sourceRoot, "worktree", "state.txt"), "preserved\n");

			const preserveResponse = await request(`/v1/workspaces/${created.id}/preserve`, {
				method: "POST",
				headers: { "idempotency-key": "postgres-preserve" },
				body: JSON.stringify({ label: "postgres-route" }),
			});
			expect(preserveResponse.status).toBe(202);
			const preserved = (await preserveResponse.json()) as {
				checkpoint: { id: string };
				operation: { id: string };
			};
			await waitFor(
				async () => (await store.getOperation(preserved.operation.id))?.state === "succeeded",
			);
			const preserveOperation = await store.getOperation(preserved.operation.id);
			expect(preserveOperation?.checkpointId).toBe(preserved.checkpoint.id);
			expect(await store.getCheckpoint(preserveOperation?.checkpointId ?? "")).not.toBeNull();

			const restoreResponse = await request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
				method: "POST",
				headers: { "idempotency-key": "postgres-restore" },
				body: JSON.stringify({ external_id: "postgres-restored" }),
			});
			expect(restoreResponse.status).toBe(202);
			const restored = (await restoreResponse.json()) as {
				workspace: { id: string };
				operation: { id: string };
			};
			const restoreOperation = await store.getOperation(restored.operation.id);
			expect(restoreOperation?.resultWorkspaceId).toBe(restored.workspace.id);
			expect(await store.getWorkspace(restoreOperation?.resultWorkspaceId ?? "")).not.toBeNull();
		} finally {
			await store.close();
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await sql.end();
			await removeStorageRoot(root);
		}
	});
});
