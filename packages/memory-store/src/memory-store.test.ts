import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceOperationRow } from "@pstdio/pocketcoder-runtime-contracts";
import { registerStoreContract } from "@pstdio/pocketcoder-testkit";
import { MemoryStore } from "./memory-store";

registerStoreContract("memory", {
	async create() {
		const store = new MemoryStore();
		await store.init();
		return { store, dispose: () => store.close() };
	},
});

function operation(principalId: string): WorkspaceOperationRow {
	const now = new Date();
	return {
		id: randomUUID(),
		principalId,
		kind: "restore",
		state: "pending",
		idempotencyKey: randomUUID(),
		requestDigest: randomUUID(),
		workspaceId: null,
		checkpointId: null,
		resultWorkspaceId: randomUUID(),
		reasonCode: null,
		attemptCount: 0,
		createdAt: now,
		updatedAt: now,
		completedAt: null,
	};
}

describe("memory store relational integrity", () => {
	test("enforces one coordinator lease per store", async () => {
		const store = new MemoryStore();
		const release = await store.acquireCoordinatorLease();

		await expect(store.acquireCoordinatorLease()).rejects.toThrow("already active");
		await release();
		await expect(store.acquireCoordinatorLease()).resolves.toBeFunction();
	});

	test("rejects operation references to rows that do not exist", async () => {
		const store = new MemoryStore();
		const principal = await store.createPrincipal("fk-test", ["admin"], ["*"]);

		await expect(store.insertOperation(operation(principal.id))).rejects.toThrow(
			"operation result workspace does not exist",
		);
	});
});

describe("principal updates", () => {
	test("updates the principal without widening explicit key restrictions", async () => {
		const store = new MemoryStore();
		const principal = await store.createPrincipal(
			"scope-test",
			["templates:read", "workspaces:read"],
			["old-template"],
		);
		const restrictedKeyId = randomUUID();
		await store.insertMachineKey({
			id: restrictedKeyId,
			principalId: principal.id,
			secretDigest: new Uint8Array([1]),
			scopes: ["templates:read"],
			createdAt: new Date(),
			expiresAt: null,
			revokedAt: null,
			lastUsedAt: null,
		});

		const updated = await store.updatePrincipal(
			principal.id,
			["workspaces:read"],
			["new-template"],
		);

		expect(updated).toMatchObject({
			scopes: ["workspaces:read"],
			templateNames: ["new-template"],
		});
		expect((await store.getMachineKeyWithPrincipal(restrictedKeyId))?.key.scopes).toEqual([
			"templates:read",
		]);
	});
});
