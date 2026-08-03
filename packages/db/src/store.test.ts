import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { SQL } from "bun";
import { migrate, migrationStatus } from "./migrate";
import { advisoryLockKey, assertValidSchema } from "./schema";
import { PostgresStore } from "./store";

// Integration tests run only when a disposable PostgreSQL is provided:
//   POCKETCODER_TEST_DATABASE_URL=postgres://... bun test
// The same suite runs against a dedicated database and a non-default schema
// inside an existing database; both placements must behave identically.

const TEST_URL = process.env.POCKETCODER_TEST_DATABASE_URL;

describe("schema helpers", () => {
	test("schema names are validated before qualification", () => {
		expect(assertValidSchema("pocketcoder")).toBe("pocketcoder");
		expect(() => assertValidSchema('bad"; DROP SCHEMA public;')).toThrow();
		expect(() => assertValidSchema("Capitals")).toThrow();
	});

	test("advisory lock keys are stable per schema and distinct across schemas", () => {
		expect(advisoryLockKey("pocketcoder")).toBe(advisoryLockKey("pocketcoder"));
		expect(advisoryLockKey("pocketcoder")).not.toBe(advisoryLockKey("other_schema"));
	});
});

function fixture() {
	return parseTemplateManifest({
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: { name: "pg-fixture", description: "pg" },
		spec: {
			version: "1.0.0",
			image: `example.test/pg@sha256:${"d".repeat(64)}`,
			harness: { command: ["sleep", "1"] },
			resources: { cpu: "1", memory: "256Mi" },
			services: {},
			persistence: {
				mounts: [
					{
						name: "worktree",
						target: "/workspace",
						maxBytes: 1024,
						maxFiles: 10,
					},
				],
			},
			outputs: { commit: { type: "gitSha" } },
		},
	});
}

async function migrateTestSchema(url: string, schema: string): Promise<SQL> {
	const sql = new SQL(url);
	await migrate(sql, schema);
	// Re-running is a no-op with matching checksums.
	expect(await migrate(sql, schema)).toEqual([]);
	const status = await migrationStatus(sql, schema);
	expect(status.every((migration) => migration.appliedAt !== null && !migration.drifted)).toBe(
		true,
	);
	return sql;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: One isolated-schema scenario intentionally verifies the full migration and store lifecycle.
describe.skipIf(!TEST_URL)("postgres store", () => {
	const schema = `pkt_test_${randomUUID().slice(0, 8)}`;

	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The assertions share one disposable schema and must remain in a single cleanup scope.
	test("migrates into an isolated schema and round-trips core entities", async () => {
		const url = TEST_URL as string;
		const sql = await migrateTestSchema(url, schema);
		const store = new PostgresStore(url, schema);
		try {
			const principal = await store.createPrincipal("pg-test", ["admin"], ["*"]);
			const parsed = fixture();
			const { row: template, created } = await store.upsertTemplate({
				name: "pg-fixture",
				version: "1.0.0",
				digest: parsed.digest,
				description: null,
				spec: parsed.manifest.spec,
			});
			expect(created).toBe(true);
			// Same content is idempotent; different content conflicts.
			expect(
				(
					await store.upsertTemplate({
						name: "pg-fixture",
						version: "1.0.0",
						digest: parsed.digest,
						description: null,
						spec: parsed.manifest.spec,
					})
				).conflict,
			).toBe(false);
			expect(
				(
					await store.upsertTemplate({
						name: "pg-fixture",
						version: "1.0.0",
						digest: "sha256:different",
						description: null,
						spec: parsed.manifest.spec,
					})
				).conflict,
			).toBe(true);

			const insert = await store.insertWorkspace({
				id: randomUUID(),
				principalId: principal.id,
				externalId: "pg-task",
				idempotencyKey: "pg-task",
				requestDigest: digestOf({ x: 1 }),
				templateId: template.id,
				templateSnapshot: snapshotOf(parsed),
				launchInput: { code: "opaque" },
				metadata: { source: "test" },
				deadlineAt: new Date(Date.now() + 60_000),
				createdAt: new Date(),
			});
			expect(insert.created).toBe(true);
			const repeat = await store.insertWorkspace({
				...{
					id: randomUUID(),
					principalId: principal.id,
					externalId: "pg-task",
					idempotencyKey: "pg-task",
					requestDigest: digestOf({ x: 1 }),
					templateId: template.id,
					templateSnapshot: snapshotOf(parsed),
					launchInput: { code: "opaque" },
					metadata: {},
					deadlineAt: new Date(Date.now() + 60_000),
					createdAt: new Date(),
				},
			});
			expect(repeat.created).toBe(false);
			expect(repeat.workspace.id).toBe(insert.workspace.id);
			const filtered = await store.listWorkspaces(principal.id, {
				metadata: { source: "test" },
				limit: 10,
			});
			expect(filtered.map((workspace) => workspace.id)).toContain(insert.workspace.id);
			const conversationInput = {
				workspaceId: insert.workspace.id,
				messageId: "pg-message-1",
				role: "assistant" as const,
				content: "durable response",
				occurredAt: new Date(),
				metadata: { provider: "agentapi" },
				createdAt: new Date(),
			};
			expect((await store.appendConversationMessage(conversationInput)).created).toBe(true);
			expect((await store.appendConversationMessage(conversationInput)).created).toBe(false);
			expect(await store.readConversation(insert.workspace.id, 0, 10)).toEqual([
				expect.objectContaining({
					seq: 1,
					messageId: "pg-message-1",
					content: "durable response",
				}),
			]);

			const provisioning = await store.transition(insert.workspace.id, {
				from: ["queued"],
				to: "provisioning",
				at: new Date(),
				patch: { launchAttempts: 1 },
			});
			expect(provisioning?.state).toBe("provisioning");
			const changeCursor = provisioning?.changeSeq ?? 0;
			const changeWait = store.waitForWorkspaceChange(insert.workspace.id, changeCursor, 1000);
			await store.updateWorkspace(
				insert.workspace.id,
				{ health: { agent: "healthy" } },
				new Date(),
			);
			await changeWait;
			expect((await store.getWorkspace(insert.workspace.id))?.changeSeq).toBe(changeCursor + 1);
			// Illegal transition is refused.
			expect(
				await store.transition(insert.workspace.id, {
					from: ["provisioning"],
					to: "ready",
					at: new Date(),
				}),
			).toBeNull();

			// Terminal transition with a patch that overlaps the automatic
			// launch_input/registration_digest clears must not produce
			// duplicate column assignments.
			const failed = await store.transition(insert.workspace.id, {
				from: ["provisioning"],
				to: "failed",
				reason: "launch_failed",
				at: new Date(),
				patch: { launchInput: null, registrationDigest: null },
			});
			expect(failed?.state).toBe("failed");
			expect(failed?.terminalAt).not.toBeNull();

			const events = await store.claimDueEvents(new Date(), 10);
			expect(events.map((e) => e.eventType)).toEqual([
				"workspace.queued",
				"workspace.provisioning",
				"workspace.failed",
			]);

			await store.appendLogs(insert.workspace.id, [
				{
					stream: "runtime",
					occurredAt: new Date(),
					content: new TextEncoder().encode("hello"),
				},
				{
					stream: "stderr",
					occurredAt: new Date(),
					content: new TextEncoder().encode("\nPermissionError: /home/onefin/.pi\n"),
				},
			]);
			const logs = await store.readLogs(insert.workspace.id, 0, 10);
			expect(logs.length).toBe(2);
			expect(new TextDecoder().decode(logs[0]?.content)).toBe("hello");
			const tail = await store.readLogTail(insert.workspace.id, 24);
			expect(new TextDecoder().decode(tail.content)).toBe("Error: /home/onefin/.pi\n");
			expect(tail.truncated).toBe(true);
			expect(tail.lastSeq).toBe(2);

			const storageId = randomUUID();
			const now = new Date();
			await store.insertWorkspaceStorage({
				id: storageId,
				workspaceId: insert.workspace.id,
				principalId: principal.id,
				providerKind: "filesystem",
				providerRef: { kind: "filesystem", id: storageId, root: "/opaque" },
				state: "retained",
				mountManifest: parsed.manifest.spec.persistence.mounts,
				logicalBytes: 12,
				fileCount: 1,
				retainedUntil: new Date(now.getTime() + 60_000),
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
				lastErrorCode: null,
			});
			const checkpointId = randomUUID();
			const manifest = {
				format: "pocketcoder-checkpoint/v1" as const,
				checkpoint_id: checkpointId,
				template_digest: parsed.digest,
				mounts: [{ name: "worktree", entries: [] }],
				logical_bytes: 0,
				file_count: 0,
			};
			await store.insertCheckpoint({
				id: checkpointId,
				workspaceId: insert.workspace.id,
				principalId: principal.id,
				storageId,
				parentCheckpointId: null,
				state: "ready",
				reasonCode: null,
				providerKind: "filesystem",
				providerRef: {
					kind: "filesystem",
					id: checkpointId,
					root: "/opaque-checkpoint",
				},
				templateSnapshot: snapshotOf(parsed),
				templateDigest: parsed.digest,
				sourceProvenance: null,
				manifest,
				manifestDigest: digestOf(manifest),
				logicalBytes: 0,
				storedBytes: 0,
				fileCount: 0,
				conversationRestore: "filesystem_only",
				label: "postgres-roundtrip",
				createdAt: now,
				updatedAt: now,
				readyAt: now,
				expiresAt: new Date(now.getTime() + 60_000),
				deletedAt: null,
			});
			const operationId = randomUUID();
			const operation = await store.insertOperation({
				id: operationId,
				principalId: principal.id,
				kind: "verify",
				state: "succeeded",
				idempotencyKey: "verify-pg",
				requestDigest: digestOf({ checkpointId }),
				workspaceId: insert.workspace.id,
				checkpointId,
				resultWorkspaceId: null,
				reasonCode: null,
				attemptCount: 1,
				createdAt: now,
				updatedAt: now,
				completedAt: now,
			});
			expect(operation.created).toBe(true);
			expect((await store.getCheckpoint(checkpointId))?.label).toBe("postgres-roundtrip");
			expect((await store.checkpointUsage(principal.id)).count).toBe(1);
			await store.appendOutput({
				workspaceId: insert.workspace.id,
				seq: 0,
				name: "commit",
				value: "a".repeat(40),
				occurredAt: now,
			});
			expect((await store.listOutputs(insert.workspace.id))[0]?.name).toBe("commit");

			// The runtime never created anything outside its schema.
			const foreign = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM information_schema.tables
				 WHERE table_schema = 'public' AND table_name LIKE 'workspace%'`,
			)) as Array<{ n: number }>;
			expect(foreign[0]?.n).toBe(0);
		} finally {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await sql.end();
			await store.close();
		}
	}, 30_000);
});
