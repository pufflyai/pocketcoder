import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type {
	MachineKeyRow,
	PrincipalRow,
	Store,
	TemplateRow,
	WorkspaceInsert,
} from "@pstdio/pocketcoder-runtime-contracts";
import { fixtureTemplateEcho } from "./fixtures";

export interface StoreContractInstance {
	store: Store;
	dispose(): Promise<void>;
}

export interface StoreContractHarness {
	enabled?: boolean;
	create(): Promise<StoreContractInstance>;
}

interface PreparedStore extends StoreContractInstance {
	principal: PrincipalRow;
	machineKey: MachineKeyRow;
	template: TemplateRow;
	workspace(overrides?: Partial<WorkspaceInsert>): WorkspaceInsert;
}

async function prepared(harness: StoreContractHarness): Promise<PreparedStore> {
	const instance = await harness.create();
	const parsed = fixtureTemplateEcho();
	const { row: template } = await instance.store.upsertTemplate({
		name: parsed.manifest.metadata.name,
		version: parsed.manifest.spec.version,
		digest: parsed.digest,
		description: parsed.manifest.metadata.description ?? null,
		spec: parsed.manifest.spec,
	});
	const principal = await instance.store.createPrincipal(
		`contract-${randomUUID()}`,
		["admin"],
		[template.name],
	);
	const machineKey: MachineKeyRow = {
		id: randomUUID(),
		principalId: principal.id,
		secretDigest: new Uint8Array([1]),
		scopes: [],
		createdAt: new Date(),
		expiresAt: null,
		revokedAt: null,
		lastUsedAt: null,
	};
	await instance.store.insertMachineKey(machineKey);
	let sequence = 0;
	return {
		...instance,
		principal,
		machineKey,
		template,
		workspace(overrides = {}) {
			sequence += 1;
			const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence));
			return {
				id: randomUUID(),
				principalId: principal.id,
				externalId: `workspace-${sequence}`,
				idempotencyKey: `key-${sequence}`,
				requestDigest: digestOf({ sequence }),
				templateId: template.id,
				templateSnapshot: snapshotOf(parsed),
				launchInput: null,
				metadata: {},
				deadlineAt: new Date(createdAt.getTime() + 60_000),
				createdAt,
				...overrides,
			};
		},
	};
}

async function withStore(
	harness: StoreContractHarness,
	run: (fixture: PreparedStore) => Promise<void>,
): Promise<void> {
	const fixture = await prepared(harness);
	try {
		await run(fixture);
	} finally {
		await fixture.dispose();
	}
}

export function registerStoreContract(name: string, harness: StoreContractHarness): void {
	registerCoreStoreContract(name, harness);
	registerPersistenceStoreContract(name, harness);
	registerTerminalStoreContract(name, harness);
}

function registerCoreStoreContract(name: string, harness: StoreContractHarness): void {
	describe.skipIf(harness.enabled === false)(`${name} store contract`, () => {
		test("reserves queue capacity and idempotency atomically", async () => {
			await withStore(harness, async ({ store, workspace }) => {
				const first = workspace();
				const second = workspace();
				const results = await Promise.all([
					store.insertWorkspace(first, { maxQueuedWorkspaces: 1 }),
					store.insertWorkspace(second, { maxQueuedWorkspaces: 1 }),
				]);
				expect(results.map((result) => result.kind).sort()).toEqual([
					"capacity_exceeded",
					"created",
				]);

				const createdIndex = results.findIndex((result) => result.kind === "created");
				const created = results[createdIndex];
				if (created?.kind !== "created") throw new Error("expected one created workspace");
				const createdInput = [first, second][createdIndex];
				if (!createdInput) throw new Error("expected created workspace input");
				expect(await store.insertWorkspace(createdInput, { maxQueuedWorkspaces: 1 })).toMatchObject(
					{
						kind: "replayed",
						workspace: { id: created.workspace.id },
					},
				);
				expect(
					await store.insertWorkspace(
						{ ...createdInput, requestDigest: digestOf({ changed: true }) },
						{ maxQueuedWorkspaces: 1 },
					),
				).toMatchObject({ kind: "conflict", conflict: "idempotency" });
			});
		});

		test("transitions state, history, notification, and outbox together", async () => {
			await withStore(harness, async ({ store, workspace }) => {
				const inserted = await store.insertWorkspace(workspace());
				if (inserted.kind !== "created") throw new Error("expected workspace");
				const changed = store.waitForWorkspaceChange(inserted.workspace.id, 1, 1_000);
				const at = new Date("2026-01-01T00:01:00Z");
				const transitioned = await store.transition(inserted.workspace.id, {
					from: ["queued"],
					to: "provisioning",
					at,
				});
				await changed;

				expect(transitioned).toMatchObject({ state: "provisioning", changeSeq: 2 });
				expect(
					await store.transition(inserted.workspace.id, {
						from: ["queued"],
						to: "canceled",
						at,
					}),
				).toBeNull();
				expect(
					(await store.listStateHistory(inserted.workspace.id)).map((row) => row.toState),
				).toEqual(["queued", "provisioning"]);
				expect(
					(await store.claimDueEvents(new Date(at.getTime() + 1), 10)).map((row) => row.eventType),
				).toEqual(["workspace.queued", "workspace.provisioning"]);
			});
		});

		test("claims admission capacity atomically across concurrent callers", async () => {
			const limitCases: Array<{
				globalActiveWorkspaces: number;
				perPrincipalActiveWorkspaces: number;
				perTemplateActiveWorkspaces: Record<string, number>;
			}> = [
				{
					globalActiveWorkspaces: 1,
					perPrincipalActiveWorkspaces: 10,
					perTemplateActiveWorkspaces: {},
				},
				{
					globalActiveWorkspaces: 10,
					perPrincipalActiveWorkspaces: 1,
					perTemplateActiveWorkspaces: {},
				},
				{
					globalActiveWorkspaces: 10,
					perPrincipalActiveWorkspaces: 10,
					perTemplateActiveWorkspaces: { "fixture-echo": 1 },
				},
			];
			for (const limits of limitCases) {
				await withStore(harness, async ({ store, workspace }) => {
					const rows = [workspace(), workspace()];
					for (const row of rows) await store.insertWorkspace(row);
					const at = new Date("2026-01-01T00:01:00Z");
					const claims = await Promise.all(
						rows.map((row) =>
							store.claimWorkspaceAdmission({
								workspaceId: row.id,
								at,
								registrationDigest: new Uint8Array([1, 2, 3]),
								registrationExpiresAt: new Date(at.getTime() + 30_000),
								limits,
							}),
						),
					);

					expect(claims.filter(Boolean)).toHaveLength(1);
					expect(await store.countActive()).toMatchObject({ global: 1 });
					expect(await store.countQueued()).toBe(1);
				});
			}
		});

		test("paginates workspaces with the same stable cursor semantics", async () => {
			await withStore(harness, async ({ store, principal, workspace }) => {
				for (let index = 0; index < 3; index += 1) await store.insertWorkspace(workspace());
				const first = await store.listWorkspaces(principal.id, { limit: 2 });
				const second = await store.listWorkspaces(principal.id, {
					limit: 2,
					cursor: first.at(-1)?.id,
				});

				expect(first).toHaveLength(2);
				expect(second).toHaveLength(1);
				expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3);
			});
		});
	});
}

function registerPersistenceStoreContract(name: string, harness: StoreContractHarness): void {
	describe.skipIf(harness.enabled === false)(`${name} persistence store contract`, () => {
		test("replays operations before capacity and preserves ready checkpoint immutability", async () => {
			await withStore(harness, async ({ store, principal, template, workspace }) => {
				const inserted = await store.insertWorkspace(workspace());
				if (inserted.kind !== "created") throw new Error("expected workspace");
				const now = new Date("2026-01-01T00:02:00Z");
				const operation = {
					id: randomUUID(),
					principalId: principal.id,
					kind: "verify" as const,
					state: "running" as const,
					idempotencyKey: "operation-key",
					requestDigest: "operation-digest",
					workspaceId: inserted.workspace.id,
					checkpointId: null,
					resultWorkspaceId: null,
					reasonCode: null,
					attemptCount: 1,
					createdAt: now,
					updatedAt: now,
					completedAt: null,
				};
				expect(
					(await store.insertOperation(operation, { maxIncompleteOperations: 1 })).created,
				).toBe(true);
				expect(
					(await store.insertOperation(operation, { maxIncompleteOperations: 1 })).created,
				).toBe(false);

				const storageId = randomUUID();
				await store.insertWorkspaceStorage({
					id: storageId,
					workspaceId: inserted.workspace.id,
					principalId: principal.id,
					providerKind: "filesystem",
					providerRef: { kind: "filesystem", id: storageId },
					state: "retained",
					mountManifest: [],
					logicalBytes: 7,
					fileCount: 1,
					retainedUntil: null,
					createdAt: now,
					updatedAt: now,
					deletedAt: null,
					lastErrorCode: null,
				});
				const checkpointId = randomUUID();
				await store.insertCheckpoint({
					id: checkpointId,
					workspaceId: inserted.workspace.id,
					principalId: principal.id,
					storageId,
					parentCheckpointId: null,
					state: "ready",
					reasonCode: null,
					providerKind: "filesystem",
					providerRef: { kind: "filesystem", id: checkpointId },
					templateSnapshot: inserted.workspace.templateSnapshot,
					templateDigest: template.digest,
					sourceProvenance: null,
					manifest: null,
					manifestDigest: "sha256:manifest",
					logicalBytes: 7,
					storedBytes: 7,
					fileCount: 1,
					conversationRestore: "filesystem_only",
					label: "immutable",
					createdAt: now,
					updatedAt: now,
					readyAt: now,
					expiresAt: null,
					deletedAt: null,
				});

				await expect(
					store.updateCheckpoint(checkpointId, { providerKind: "changed" }, new Date()),
				).rejects.toThrow("immutable");
				expect(await store.checkpointUsage(principal.id)).toEqual({ count: 1, logicalBytes: 7 });
			});
		});
	});
}

function registerTerminalStoreContract(name: string, harness: StoreContractHarness): void {
	describe.skipIf(harness.enabled === false)(`${name} terminal store contract`, () => {
		test("audits sessions and enforces the open-session limit", async () => {
			await withStore(harness, async ({ store, machineKey, workspace }) => {
				const inserted = await store.insertWorkspace(workspace());
				if (inserted.kind !== "created") throw new Error("expected workspace");
				const openedAt = new Date("2026-01-01T00:03:00Z");
				const first = await store.openTerminalSession(
					{
						sessionId: randomUUID(),
						workspaceId: inserted.workspace.id,
						keyId: machineKey.id,
						openedAt,
					},
					1,
				);
				expect(first?.closeReason).toBeNull();
				expect(
					await store.openTerminalSession(
						{
							sessionId: randomUUID(),
							workspaceId: inserted.workspace.id,
							keyId: machineKey.id,
							openedAt: new Date(openedAt.getTime() + 1),
						},
						1,
					),
				).toBeNull();
				if (!first) throw new Error("expected terminal session");
				const closed = await store.closeTerminalSession(first.sessionId, {
					closedAt: new Date(openedAt.getTime() + 1000),
					closeReason: "exit",
					exitCode: 7,
					bytesIn: 4,
					bytesOut: 8,
				});
				if (!closed) throw new Error("expected closed terminal session");
				expect(closed).toMatchObject({ closeReason: "exit", exitCode: 7, bytesIn: 4, bytesOut: 8 });
				expect(
					await store.closeTerminalSession(first.sessionId, {
						closedAt: new Date(),
						closeReason: "client_closed",
						exitCode: null,
						bytesIn: 0,
						bytesOut: 0,
					}),
				).toBeNull();
				expect(await store.listTerminalSessions(inserted.workspace.id, undefined, 10)).toEqual([
					closed,
				]);
			});
		});
	});
}
