import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import {
	FakeDriver,
	fixtureTemplateEcho,
	fixtureTemplatePersistent,
} from "@pstdio/pocketcoder-testkit";
import {
	DEFAULT_LIMITS,
	resolveWarmPools,
	Scheduler,
	type Store,
	type WarmPoolConnections,
	WarmPoolManager,
} from "./index";

const secrets = {
	generate: () => `secret-${randomUUID()}`,
	digest: (value: string) => new TextEncoder().encode(value),
};
const noWorkspaceConnections = {
	isConnected: () => false,
	shutdown: () => false,
	signal: () => false,
	close: () => {},
};

async function seed(store: Store, persistent = false) {
	const parsed = persistent ? fixtureTemplatePersistent() : fixtureTemplateEcho();
	const template = (
		await store.upsertTemplate({
			name: parsed.manifest.metadata.name,
			version: parsed.manifest.spec.version,
			digest: parsed.digest,
			description: null,
			spec: parsed.manifest.spec,
		})
	).row;
	const principal = await store.createPrincipal("pool-test", ["admin"], ["*"]);
	return { parsed, template, principal };
}

async function queue(store: Store, seeded: Awaited<ReturnType<typeof seed>>, name: string) {
	const now = new Date();
	const result = await store.insertWorkspace({
		id: randomUUID(),
		principalId: seeded.principal.id,
		externalId: name,
		idempotencyKey: name,
		requestDigest: digestOf({ name }),
		templateId: seeded.template.id,
		templateSnapshot: snapshotOf(seeded.parsed),
		launchInput: { task: name },
		metadata: {},
		deadlineAt: new Date(now.getTime() + 60_000),
		createdAt: now,
	});
	if (result.kind === "capacity_exceeded") throw new Error("unexpected queue capacity failure");
	return result.workspace;
}

class Assignments implements WarmPoolConnections {
	readonly inputs: Array<{ runtimeId: string; workspaceId: string }> = [];
	assign(runtimeId: string, input: { workspace_id: string }): boolean {
		this.inputs.push({ runtimeId, workspaceId: input.workspace_id });
		return true;
	}
	isConnected(): boolean {
		return true;
	}
	close(): void {}
}

describe("warm workspace pooling", () => {
	test("warm p95 removes provider creation and beats the cached cold path by 80%", async () => {
		const samples = 8;
		const coldStore = new MemoryStore();
		const coldDriver = new FakeDriver();
		coldDriver.createDelayMs = 30;
		const coldSeeded = await seed(coldStore);
		const coldScheduler = new Scheduler({
			store: coldStore,
			driver: coldDriver,
			connections: noWorkspaceConnections,
			secrets,
			limits: DEFAULT_LIMITS,
			workspaceServerUrl: "http://127.0.0.1:7080",
		});
		const cold: number[] = [];
		for (let index = 0; index < samples; index += 1) {
			await queue(coldStore, coldSeeded, `cold-${index}`);
			const started = performance.now();
			await coldScheduler.admit();
			cold.push(performance.now() - started);
		}

		const warmStore = new MemoryStore();
		const warmDriver = new FakeDriver();
		warmDriver.createDelayMs = 30;
		const warmSeeded = await seed(warmStore);
		const pools = await resolveWarmPools(
			warmStore,
			[
				{
					template: warmSeeded.template.name,
					minReady: samples,
					maxWarmAgeMs: 60_000,
					missPolicy: "cold",
					waitTimeoutMs: 1000,
				},
			],
			warmDriver.kind,
			samples,
		);
		const manager = new WarmPoolManager({
			store: warmStore,
			driver: warmDriver,
			connections: new Assignments(),
			secrets,
			workspaceServerUrl: "http://127.0.0.1:7080",
			pools,
		});
		await manager.reconcile();
		for (const runtime of await warmStore.listWarmPoolRuntimes())
			await manager.markReady(runtime.id);
		const warmScheduler = new Scheduler({
			store: warmStore,
			driver: warmDriver,
			connections: noWorkspaceConnections,
			secrets,
			limits: DEFAULT_LIMITS,
			workspaceServerUrl: "http://127.0.0.1:7080",
			warmPool: manager,
		});
		const warm: number[] = [];
		for (let index = 0; index < samples; index += 1) {
			await queue(warmStore, warmSeeded, `warm-${index}`);
			const started = performance.now();
			await warmScheduler.admit();
			warm.push(performance.now() - started);
		}
		const p95 = (values: number[]) =>
			[...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
		expect(p95(warm)).toBeLessThanOrEqual(p95(cold) * 0.2);
		expect(warmDriver.created).toHaveLength(0);
	});
	test("leases a ready runtime without calling cold provider creation", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const seeded = await seed(store);
		const pools = await resolveWarmPools(
			store,
			[
				{
					template: seeded.template.name,
					version: seeded.template.version,
					minReady: 1,
					maxWarmAgeMs: 60_000,
					missPolicy: "cold",
					waitTimeoutMs: 1000,
				},
			],
			driver.kind,
			10,
		);
		const assignments = new Assignments();
		const manager = new WarmPoolManager({
			store,
			driver,
			connections: assignments,
			secrets,
			workspaceServerUrl: "http://127.0.0.1:7080",
			pools,
		});
		await manager.reconcile();
		const runtime = (await store.listWarmPoolRuntimes())[0];
		expect(runtime?.providerRef).not.toBeNull();
		expect(await manager.markReady(runtime?.id ?? "")).toBe(true);

		const workspace = await queue(store, seeded, "warm-hit");
		const scheduler = new Scheduler({
			store,
			driver,
			connections: noWorkspaceConnections,
			secrets,
			limits: DEFAULT_LIMITS,
			workspaceServerUrl: "http://127.0.0.1:7080",
			warmPool: manager,
		});
		await scheduler.admit();

		const after = await store.getWorkspace(workspace.id);
		expect(after?.state).toBe("provisioning");
		expect(after?.provisioningMode).toBe("warm");
		expect(driver.created).toHaveLength(0);
		expect(assignments.inputs).toEqual([
			{ runtimeId: runtime?.id as string, workspaceId: workspace.id },
		]);
		expect(manager.metrics.warmHits).toBe(1);
	});

	test("a ready runtime is claimed once and a concurrent miss falls back cold", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const seeded = await seed(store);
		const pools = await resolveWarmPools(
			store,
			[
				{
					template: seeded.template.name,
					minReady: 1,
					maxWarmAgeMs: 60_000,
					missPolicy: "cold",
					waitTimeoutMs: 1000,
				},
			],
			driver.kind,
			10,
		);
		const manager = new WarmPoolManager({
			store,
			driver,
			connections: new Assignments(),
			secrets,
			workspaceServerUrl: "http://127.0.0.1:7080",
			pools,
		});
		await manager.reconcile();
		const runtime = (await store.listWarmPoolRuntimes())[0];
		await manager.markReady(runtime?.id ?? "");
		await queue(store, seeded, "first");
		await queue(store, seeded, "second");
		const scheduler = new Scheduler({
			store,
			driver,
			connections: noWorkspaceConnections,
			secrets,
			limits: DEFAULT_LIMITS,
			workspaceServerUrl: "http://127.0.0.1:7080",
			warmPool: manager,
		});
		await scheduler.admit();
		expect(manager.metrics.warmHits).toBe(1);
		expect(driver.created).toHaveLength(1);
		expect((await store.listWarmPoolRuntimes()).filter((row) => row.workspaceId)).toHaveLength(1);
	});

	test("rejects persistent templates before capacity is served", async () => {
		const store = new MemoryStore();
		const seeded = await seed(store, true);
		await expect(
			resolveWarmPools(
				store,
				[
					{
						template: seeded.template.name,
						minReady: 1,
						maxWarmAgeMs: 60_000,
						missPolicy: "cold",
						waitTimeoutMs: 1000,
					},
				],
				"fake",
				10,
			),
		).rejects.toThrow("persistent mounts are not supported");
	});
});
