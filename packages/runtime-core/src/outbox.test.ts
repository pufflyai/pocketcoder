import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { OutboxDispatcher } from "./outbox";

async function storeWithEvent() {
	const store = new MemoryStore();
	const principal = await store.createPrincipal("p", ["admin"], ["*"]);
	const echo = fixtureTemplateEcho();
	const { row } = await store.upsertTemplate({
		name: echo.manifest.metadata.name,
		version: echo.manifest.spec.version,
		digest: echo.digest,
		description: null,
		spec: echo.manifest.spec,
	});
	await store.insertWorkspace({
		id: randomUUID(),
		principalId: principal.id,
		externalId: "task",
		idempotencyKey: "task",
		requestDigest: digestOf({}),
		templateId: row.id,
		templateSnapshot: snapshotOf(echo),
		launchInput: null,
		metadata: {},
		deadlineAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
	});
	return store;
}

describe("outbox dispatcher", () => {
	test("delivers signed events and marks them delivered", async () => {
		const store = await storeWithEvent();
		const seen: Array<{ sig: string | null; id: string | null; body: string }> = [];
		const dispatcher = new OutboxDispatcher({
			store,
			sinkUrl: "http://sink.test/events",
			sign: (ts, body) => `sha256=signed:${ts.length}:${body.length}`,
			fetchFn: (async (_url: unknown, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				seen.push({
					sig: headers.get("X-Pocketcoder-Signature"),
					id: headers.get("X-Pocketcoder-Event-ID"),
					body: String(init?.body),
				});
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await dispatcher.tick();
		expect(seen.length).toBe(1);
		expect(seen[0]?.sig?.startsWith("sha256=signed:")).toBe(true);
		expect(seen[0]?.id).toBeTruthy();
		expect(JSON.parse(seen[0]?.body ?? "{}").type).toBe("workspace.queued");
		// Nothing left to deliver.
		expect((await store.claimDueEvents(new Date(), 10)).length).toBe(0);
	});

	test("failed delivery retries with backoff", async () => {
		const store = await storeWithEvent();
		let calls = 0;
		const dispatcher = new OutboxDispatcher({
			store,
			sinkUrl: "http://sink.test/events",
			sign: () => "sha256=x",
			fetchFn: (async () => {
				calls += 1;
				return new Response("boom", { status: 500 });
			}) as unknown as typeof fetch,
		});
		await dispatcher.tick();
		expect(calls).toBe(1);
		// Immediately due again? No: the retry is scheduled in the future.
		await dispatcher.tick();
		expect(calls).toBe(1);
		// After the backoff elapses the event is claimable again.
		const future = new Date(Date.now() + 60_000);
		const due = await store.claimDueEvents(future, 10);
		expect(due.length).toBe(1);
		expect(due[0]?.lastErrorCode).toBe("http_500");
	});

	test("without a sink URL events are drained immediately", async () => {
		const store = await storeWithEvent();
		const dispatcher = new OutboxDispatcher({
			store,
			sinkUrl: null,
			sign: () => "",
		});
		await dispatcher.tick();
		expect((await store.claimDueEvents(new Date(), 10)).length).toBe(0);
	});
});
