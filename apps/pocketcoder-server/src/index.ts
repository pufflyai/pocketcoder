import { signEvent } from "@pstdio/pocketcoder-auth";
import { PostgresStore } from "@pstdio/pocketcoder-db";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import {
	loadTemplateDir,
	OutboxDispatcher,
	reconcileProviders,
	type Store,
} from "@pstdio/pocketcoder-runtime-core";
import { MemoryStore } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "./app";
import { loadConfig } from "./config";

// pocketcoder-server entrypoint: one Hono application serving REST, OpenAPI,
// the agent WSS endpoint, and the relay, plus the scheduler and outbox loops.

const log = (msg: string) => console.log(`[pocketcoder-server] ${msg}`);

async function main(): Promise<void> {
	const config = loadConfig();
	const store: Store =
		config.storeKind === "postgres"
			? new PostgresStore(config.databaseUrl as string, config.databaseSchema)
			: new MemoryStore();
	await store.init();
	log(
		`store: ${config.storeKind}${config.storeKind === "postgres" ? ` (schema ${config.databaseSchema})` : ""}`,
	);

	if (config.templateDir) {
		const result = await loadTemplateDir(store, config.templateDir);
		for (const row of result.loaded) {
			log(`template loaded: ${row.name}@${row.version} (${row.digest.slice(0, 19)}...)`);
		}
		for (const err of result.errors) {
			console.error(`[pocketcoder-server] template error in ${err.file}: ${err.message}`);
		}
		if (result.errors.length > 0) {
			throw new Error("refusing to start with invalid template files");
		}
	}

	const driver = new DockerDriver(config.inputDir ? { inputDir: config.inputDir } : {});
	const { app, websocket, scheduler } = buildServer({
		store,
		driver,
		pepper: config.pepper,
		limits: config.limits,
		workspaceServerUrl: config.workspaceServerUrl,
		log,
	});

	try {
		await reconcileProviders({ store, driver, log });
	} catch (err) {
		log(`startup reconciliation skipped: ${String(err)}`);
	}

	const outbox = new OutboxDispatcher({
		store,
		sinkUrl: config.eventSinkUrl,
		sign: (timestamp, body) => signEvent(config.eventSigningKey, timestamp, body),
		onError: (context, err) => log(`${context}: ${String(err)}`),
	});

	let schedulerBusy = false;
	const schedulerTimer = setInterval(() => {
		if (schedulerBusy) return;
		schedulerBusy = true;
		scheduler
			.tick()
			.catch((err) => log(`scheduler tick failed: ${String(err)}`))
			.finally(() => {
				schedulerBusy = false;
			});
	}, config.schedulerIntervalMs);

	let outboxBusy = false;
	const outboxTimer = setInterval(() => {
		if (outboxBusy) return;
		outboxBusy = true;
		outbox
			.tick()
			.catch((err) => log(`outbox tick failed: ${String(err)}`))
			.finally(() => {
				outboxBusy = false;
			});
	}, config.outboxIntervalMs);

	const server = Bun.serve({
		hostname: config.listenHost,
		port: config.listenPort,
		fetch: app.fetch,
		websocket,
	});
	log(`listening on http://${config.listenHost}:${server.port}`);
	log(`workspaces reach this server at ${config.workspaceServerUrl}`);

	const shutdown = async () => {
		log("shutting down");
		clearInterval(schedulerTimer);
		clearInterval(outboxTimer);
		server.stop();
		await store.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`[pocketcoder-server] fatal: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
