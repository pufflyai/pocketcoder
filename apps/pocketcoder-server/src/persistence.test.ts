import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplatePersistent, MemoryStore } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "./app";

const roots: string[] = [];
const pepper = "persistence-test-pepper";

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => {});
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

async function server() {
	const root = await mkdtemp(join(tmpdir(), "pocketcoder-persistence-api-"));
	roots.push(root);
	const store = new MemoryStore();
	const driver = new FakeDriver();
	const storageDriver = new FilesystemStorageDriver({
		workspaceRoot: join(root, "workspaces"),
		checkpointRoot: join(root, "checkpoints"),
	});
	const parsed = fixtureTemplatePersistent();
	await store.upsertTemplate({
		name: parsed.manifest.metadata.name,
		version: parsed.manifest.spec.version,
		digest: parsed.digest,
		description: parsed.manifest.metadata.description ?? null,
		spec: parsed.manifest.spec,
	});
	const scopes = [
		"templates:read",
		"workspaces:create",
		"workspaces:read",
		"workspaces:cancel",
		"workspaces:preserve",
		"workspaces:restore",
		"checkpoints:read",
		"checkpoints:delete",
		"outputs:read",
		"conversations:read",
		"conversations:delete",
		"services:relay",
		"logs:read",
	];
	const principal = await store.createPrincipal("persistent-user", scopes, ["fixture-persistent"]);
	const key = issueMachineKey(pepper);
	await store.insertMachineKey({
		id: key.id,
		principalId: principal.id,
		secretDigest: key.secretDigest,
		scopes,
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	});
	const built = buildServer({
		store,
		driver,
		storageDriver,
		pepper,
		limits: DEFAULT_LIMITS,
		workspaceServerUrl: "http://127.0.0.1:0",
	});
	const request = (path: string, init: RequestInit = {}) =>
		built.app.request(path, {
			...init,
			headers: {
				authorization: `Bearer ${key.token}`,
				"content-type": "application/json",
				...(init.headers ?? {}),
			},
		});
	return { ...built, store, driver, storageDriver, request };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition timed out");
}

describe("persistent workspace REST workflow", () => {
	test("preserves, verifies, restores, and keeps forks independent", async () => {
		const testServer = await server();
		const createdResponse = await testServer.request("/v1/workspaces", {
			method: "POST",
			headers: { "idempotency-key": "create-persistent" },
			body: JSON.stringify({
				external_id: "persistent-source",
				template: { name: "fixture-persistent" },
			}),
		});
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as { id: string };
		await testServer.scheduler.tick();
		await waitFor(async () => {
			const [workspace, storage] = await Promise.all([
				testServer.store.getWorkspace(created.id),
				testServer.store.getWorkspaceStorage(created.id),
			]);
			return workspace?.providerRef != null && storage?.state === "ready";
		});
		const now = new Date();
		await testServer.store.transition(created.id, {
			from: ["provisioning"],
			to: "connected",
			at: now,
		});
		await testServer.store.transition(created.id, {
			from: ["connected"],
			to: "ready",
			at: now,
			patch: { readyAt: now, lastActivityAt: now },
		});
		const sourceStorage = await testServer.store.getWorkspaceStorage(created.id);
		expect(sourceStorage?.state).toBe("ready");
		const sourceRoot = String(sourceStorage?.providerRef.root);
		await mkdir(join(sourceRoot, "worktree", "src"), { recursive: true });
		await writeFile(
			join(sourceRoot, "worktree", "src", "state.ts"),
			"export const checkpointed = true;\n",
		);

		const preserve = await testServer.request(`/v1/workspaces/${created.id}/preserve`, {
			method: "POST",
			headers: { "idempotency-key": "preserve-1" },
			body: JSON.stringify({ label: "before-test" }),
		});
		expect(preserve.status).toBe(202);
		const preserveBody = (await preserve.json()) as {
			checkpoint: { id: string };
			operation: { id: string };
		};
		await waitFor(
			async () => (await testServer.store.getWorkspace(created.id))?.state === "preserved",
		);
		const checkpoint = await testServer.store.getCheckpoint(preserveBody.checkpoint.id);
		if (!checkpoint) throw new Error("expected preserve to create a checkpoint");
		expect(checkpoint?.state).toBe("ready");
		expect(checkpoint?.conversationRestore).toBe("filesystem_only");
		const historicalSource = await testServer.request(`/v1/workspaces/${created.id}`);
		expect((await historicalSource.json()) as unknown).toMatchObject({
			persistence: {
				conversation_restore: "filesystem_only",
				conversation_resume: { status: "unsupported", reason: "filesystem_only" },
			},
		});
		const unsupportedResume = await testServer.request(`/v1/workspaces/${created.id}/resume`, {
			method: "POST",
			headers: { "idempotency-key": "resume-unsupported" },
			body: JSON.stringify({ external_id: "must-not-be-created" }),
		});
		expect(unsupportedResume.status).toBe(409);
		expect((await unsupportedResume.json()) as unknown).toMatchObject({
			error: {
				code: "resume.unsupported",
				details: { reason: "filesystem_only", checkpoint_id: checkpoint.id },
			},
		});
		expect(
			(
				await testServer.store.listWorkspaces(
					(await testServer.store.listPrincipals())[0]?.id ?? "",
					{ externalId: "must-not-be-created", limit: 10 },
				)
			).length,
		).toBe(0);
		const supportedCheckpoint = await testServer.store.insertCheckpoint({
			...checkpoint,
			id: randomUUID(),
			parentCheckpointId: checkpoint.id,
			conversationRestore: "supported",
			label: "supported-resume-fixture",
			createdAt: new Date(checkpoint.createdAt.getTime() + 1),
			updatedAt: new Date(checkpoint.updatedAt.getTime() + 1),
			readyAt: new Date((checkpoint.readyAt ?? checkpoint.updatedAt).getTime() + 1),
		});
		const supportedResume = await testServer.request(`/v1/workspaces/${created.id}/resume`, {
			method: "POST",
			headers: { "idempotency-key": "resume-supported" },
			body: JSON.stringify({ external_id: "resumed-conversation" }),
		});
		expect(supportedResume.status).toBe(202);
		expect((await supportedResume.json()) as unknown).toMatchObject({
			workspace: {
				external_id: "resumed-conversation",
				origin_workspace_id: created.id,
				restored_from_checkpoint_id: supportedCheckpoint.id,
			},
			resume: {
				status: "supported",
				reason: null,
				source_workspace_id: created.id,
				checkpoint_id: supportedCheckpoint.id,
			},
		});
		expect(testServer.driver.stopped.length).toBeGreaterThan(0);
		expect(testServer.driver.terminated.length).toBeGreaterThan(0);

		const repeated = await testServer.request(`/v1/workspaces/${created.id}/preserve`, {
			method: "POST",
			headers: { "idempotency-key": "preserve-1" },
			body: JSON.stringify({ label: "before-test" }),
		});
		expect(repeated.status).toBe(202);
		expect(((await repeated.json()) as { checkpoint: { id: string } }).checkpoint.id).toBe(
			checkpoint.id,
		);

		const verify = await testServer.request(`/v1/checkpoints/${checkpoint.id}/verify`, {
			method: "POST",
			headers: { "idempotency-key": "verify-1" },
		});
		expect(verify.status).toBe(202);
		expect(((await verify.json()) as { state: string }).state).toBe("succeeded");

		const restore = await testServer.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
			method: "POST",
			headers: { "idempotency-key": "restore-1" },
			body: JSON.stringify({ external_id: "restored-fork" }),
		});
		expect(restore.status).toBe(202);
		const restored = (await restore.json()) as {
			workspace: {
				id: string;
				origin_workspace_id: string;
				restored_from_checkpoint_id: string;
			};
			operation: { id: string };
		};
		expect(restored.workspace.id).not.toBe(created.id);
		expect(restored.workspace.origin_workspace_id).toBe(created.id);
		expect(restored.workspace.restored_from_checkpoint_id).toBe(checkpoint.id);
		const repeatedRestore = await testServer.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
			method: "POST",
			headers: { "idempotency-key": "restore-1" },
			body: JSON.stringify({ external_id: "restored-fork" }),
		});
		expect(repeatedRestore.status).toBe(202);
		expect(((await repeatedRestore.json()) as { workspace: { id: string } }).workspace.id).toBe(
			restored.workspace.id,
		);
		await testServer.scheduler.tick();
		await waitFor(async () => {
			const operation = await testServer.store.getOperation(restored.operation.id);
			return operation?.state === "succeeded";
		});
		const restoredStorage = await testServer.store.getWorkspaceStorage(restored.workspace.id);
		const restoredFile = join(
			String(restoredStorage?.providerRef.root),
			"worktree",
			"src",
			"state.ts",
		);
		expect(await readFile(restoredFile, "utf8")).toContain("checkpointed = true");
		await writeFile(restoredFile, "fork mutation\n");
		await testServer.storageDriver.verifyCheckpoint(
			checkpoint?.providerRef as never,
			checkpoint?.manifest as never,
		);
		expect(testServer.driver.inputFor(restored.workspace.id)?.launch_mode).toBe("restore");
	});

	test("persists only declared, bounded output metadata", async () => {
		const testServer = await server();
		const createdResponse = await testServer.request("/v1/workspaces", {
			method: "POST",
			headers: { "idempotency-key": "output-workspace" },
			body: JSON.stringify({
				external_id: "output-workspace",
				template: { name: "fixture-persistent" },
			}),
		});
		const workspace = (await createdResponse.json()) as { id: string };
		await testServer.persistence.publishOutput(workspace.id, "commit", "a".repeat(40));
		await expect(
			testServer.persistence.publishOutput(workspace.id, "undeclared", "value"),
		).rejects.toThrow("not declared");
		const outputs = await testServer.request(`/v1/workspaces/${workspace.id}/outputs`);
		expect(outputs.status).toBe(200);
		expect(((await outputs.json()) as { items: Array<{ name: string }> }).items[0]?.name).toBe(
			"commit",
		);
	});
});
