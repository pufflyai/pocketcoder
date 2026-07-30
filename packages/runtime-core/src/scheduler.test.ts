import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import {
	FakeDriver,
	fixtureTemplateEcho,
	fixtureTemplateSleep,
	MemoryStore,
} from "@pstdio/pocketcoder-testkit";
import { type ConnectionHub, DEFAULT_LIMITS, Scheduler, type Store } from "./index";

const noHub: ConnectionHub = {
	isConnected: () => false,
	shutdown: () => false,
	signal: () => false,
	close: () => {},
};

const secrets = {
	generate: () => `secret-${randomUUID()}`,
	digest: (s: string) => new TextEncoder().encode(s),
};

async function seed(store: Store) {
	const principal = await store.createPrincipal("test-backend", ["admin"], ["*"]);
	const echo = fixtureTemplateEcho();
	const sleep = fixtureTemplateSleep();
	const echoRow = (
		await store.upsertTemplate({
			name: echo.manifest.metadata.name,
			version: echo.manifest.spec.version,
			digest: echo.digest,
			description: null,
			spec: echo.manifest.spec,
		})
	).row;
	const sleepRow = (
		await store.upsertTemplate({
			name: sleep.manifest.metadata.name,
			version: sleep.manifest.spec.version,
			digest: sleep.digest,
			description: null,
			spec: sleep.manifest.spec,
		})
	).row;
	return { principal, echo, sleep, echoRow, sleepRow };
}

async function queueWorkspace(
	store: Store,
	principalId: string,
	templateId: string,
	parsed: ReturnType<typeof fixtureTemplateEcho>,
	externalId: string = randomUUID(),
	createdAt = new Date(),
) {
	const body = { external_id: externalId };
	const result = await store.insertWorkspace({
		id: randomUUID(),
		principalId,
		externalId,
		idempotencyKey: externalId,
		requestDigest: digestOf(body),
		templateId,
		templateSnapshot: snapshotOf(parsed),
		launchInput: { bootstrap_code: "opaque" },
		metadata: {},
		deadlineAt: new Date(createdAt.getTime() + 2 * 60 * 60_000),
		createdAt,
	});
	return result.workspace;
}

function makeScheduler(store: Store, driver: FakeDriver, overrides = {}) {
	return new Scheduler({
		store,
		driver,
		connections: noHub,
		secrets,
		limits: { ...DEFAULT_LIMITS, ...overrides },
		workspaceServerUrl: "http://127.0.0.1:0",
	});
}

describe("scheduler admission", () => {
	test("launches queued workspaces through the driver with provider input", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { principal, echo, echoRow } = await seed(store);
		const ws = await queueWorkspace(store, principal.id, echoRow.id, echo);
		await makeScheduler(store, driver).tick();

		const after = await store.getWorkspace(ws.id);
		expect(after?.state).toBe("provisioning");
		expect(after?.providerKind).toBe("fake");
		expect(after?.registrationDigest).not.toBeNull();
		const input = driver.inputFor(ws.id);
		expect(input?.workspace_id).toBe(ws.id);
		expect(input?.template_digest).toBe(echo.digest);
		expect(input?.launch_input).toEqual({ bootstrap_code: "opaque" });
		expect(input?.registration_secret.startsWith("secret-")).toBe(true);
	});

	test("respects the global active limit and preserves FIFO", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { principal, echo, echoRow } = await seed(store);
		const t0 = Date.now();
		const rows = [];
		for (let i = 0; i < 4; i += 1) {
			rows.push(
				await queueWorkspace(store, principal.id, echoRow.id, echo, `task-${i}`, new Date(t0 + i)),
			);
		}
		await makeScheduler(store, driver, { globalActiveWorkspaces: 2 }).tick();
		const states = await Promise.all(rows.map((r) => store.getWorkspace(r.id)));
		expect(states.map((s) => s?.state)).toEqual([
			"provisioning",
			"provisioning",
			"queued",
			"queued",
		]);
	});

	test("rotates admission fairly across principals", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { echo, echoRow } = await seed(store);
		const a = await store.createPrincipal("a", ["admin"], ["*"]);
		const b = await store.createPrincipal("b", ["admin"], ["*"]);
		const t0 = Date.now();
		// Principal a queues three before b's first.
		for (let i = 0; i < 3; i += 1) {
			await queueWorkspace(store, a.id, echoRow.id, echo, `a-${i}`, new Date(t0 + i));
		}
		await queueWorkspace(store, b.id, echoRow.id, echo, "b-0", new Date(t0 + 10));
		await makeScheduler(store, driver, { globalActiveWorkspaces: 2 }).tick();
		const admitted = driver.created.map((l) => l.workspace.externalId).sort();
		expect(admitted).toEqual(["a-0", "b-0"]);
	});

	test("bounded launch retry, then failed", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { principal, echo, echoRow } = await seed(store);
		const ws = await queueWorkspace(store, principal.id, echoRow.id, echo);
		const scheduler = makeScheduler(store, driver, { maxLaunchAttempts: 2 });

		driver.failNextCreate = true;
		await scheduler.tick();
		expect((await store.getWorkspace(ws.id))?.state).toBe("queued");

		driver.failNextCreate = true;
		await scheduler.tick();
		const after = await store.getWorkspace(ws.id);
		expect(after?.state).toBe("failed");
		expect(after?.reasonCode).toBe("launch_failed");
	});
});

describe("scheduler sweeps", () => {
	test("queue age expiry", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { principal, echo, echoRow } = await seed(store);
		const old = new Date(Date.now() - 60 * 60_000);
		const ws = await queueWorkspace(store, principal.id, echoRow.id, echo, "old-task", old);
		const scheduler = makeScheduler(store, driver);
		await scheduler.sweep();
		const after = await store.getWorkspace(ws.id);
		expect(after?.state).toBe("expired");
		expect(after?.reasonCode).toBe("queue_timeout");
	});

	test("registration timeout fails a provisioning workspace and cleans the provider", async () => {
		const store = new MemoryStore();
		const driver = new FakeDriver();
		const { principal, echo, echoRow } = await seed(store);
		const ws = await queueWorkspace(store, principal.id, echoRow.id, echo);
		const scheduler = makeScheduler(store, driver);
		await scheduler.tick();
		// Force the registration deadline into the past.
		await store.updateWorkspace(
			ws.id,
			{ registrationExpiresAt: new Date(Date.now() - 1000) },
			new Date(),
		);
		await scheduler.sweep();
		const after = await store.getWorkspace(ws.id);
		expect(after?.state).toBe("failed");
		expect(after?.reasonCode).toBe("registration_timeout");
		expect(driver.terminated.length).toBe(1);
	});

	test("cancellation without a provider goes straight to canceled", async () => {
		const store = new MemoryStore();
		const { principal, echo, echoRow } = await seed(store);
		const ws = await queueWorkspace(store, principal.id, echoRow.id, echo);
		const queued = await store.transition(ws.id, {
			from: ["queued"],
			to: "canceled",
			reason: "canceled_by_caller",
			at: new Date(),
		});
		expect(queued?.state).toBe("canceled");
		// Terminal workspaces cannot transition again.
		const again = await store.transition(ws.id, {
			from: ["canceled"],
			to: "queued",
			at: new Date(),
		});
		expect(again).toBeNull();
	});
});
