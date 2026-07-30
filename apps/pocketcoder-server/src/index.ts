import { signEvent } from "@pstdio/pocketcoder-auth";
import { PostgresStore } from "@pstdio/pocketcoder-db";
import {
	DockerDriver,
	FileSecretResolver,
	FilesystemStorageDriver,
	KubernetesDriver,
	KubernetesPvcStorageDriver,
	KubernetesSecretResolver,
} from "@pstdio/pocketcoder-drivers";
import {
	loadTemplateDir,
	OutboxDispatcher,
	reconcilePersistence,
	reconcileProviders,
	type Store,
} from "@pstdio/pocketcoder-runtime-core";
import { MemoryStore } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "./app";
import { loadConfig, type ServerConfig } from "./config";

// pocketcoder-server entrypoint: one Hono application serving REST, OpenAPI,
// the agent WSS endpoint, and the relay, plus the scheduler and outbox loops.

const log = (msg: string) => console.log(`[pocketcoder-server] ${msg}`);

async function initializeStore(config: ServerConfig): Promise<Store> {
	const store: Store =
		config.storeKind === "postgres"
			? new PostgresStore(config.databaseUrl as string, config.databaseSchema)
			: new MemoryStore();
	await store.init();
	log(
		`store: ${config.storeKind}${config.storeKind === "postgres" ? ` (schema ${config.databaseSchema})` : ""}`,
	);
	return store;
}

async function loadConfiguredTemplates(store: Store, templateDir: string | null): Promise<void> {
	if (!templateDir) return;
	const result = await loadTemplateDir(store, templateDir);
	for (const row of result.loaded) {
		log(`template loaded: ${row.name}@${row.version} (${row.digest.slice(0, 19)}...)`);
	}
	for (const error of result.errors) {
		console.error(`[pocketcoder-server] template error in ${error.file}: ${error.message}`);
	}
	if (result.errors.length > 0) {
		throw new Error("refusing to start with invalid template files");
	}
}

function createWorkspaceDriver(config: ServerConfig) {
	if (config.driverKind === "kubernetes") {
		return new KubernetesDriver({
			namespace: config.kubernetesNamespace,
			...(config.kubernetesServiceAccount
				? { serviceAccountName: config.kubernetesServiceAccount }
				: {}),
		});
	}
	return new DockerDriver(config.inputDir ? { inputDir: config.inputDir } : {});
}

function createStorageDriver(config: ServerConfig) {
	if (config.storageBackend === "kubernetes-pvc") {
		return new KubernetesPvcStorageDriver({
			workspaceRoot: config.workspaceDataDir as string,
			checkpointRoot: config.checkpointDir as string,
			workspaceClaimName: config.kubernetesWorkspaceClaim as string,
			workspaceClaimSubPath: config.kubernetesWorkspaceSubPath,
		});
	}
	if (config.storageBackend === "filesystem") {
		return new FilesystemStorageDriver({
			workspaceRoot: config.workspaceDataDir as string,
			checkpointRoot: config.checkpointDir as string,
		});
	}
	return undefined;
}

function createSecretResolver(config: ServerConfig) {
	if (config.secretProvider === "kubernetes") return new KubernetesSecretResolver();
	if (config.secretProvider === "file") {
		return new FileSecretResolver({ root: config.secretRoot as string });
	}
	return undefined;
}

async function reconcileStartup(
	store: Store,
	driver: ReturnType<typeof createWorkspaceDriver>,
	storageDriver: ReturnType<typeof createStorageDriver>,
): Promise<void> {
	try {
		await reconcileProviders({
			store,
			driver,
			...(storageDriver ? { storageDriver } : {}),
			log,
		});
		await reconcilePersistence({ store, driver, storageDriver, log });
	} catch (error) {
		log(`startup reconciliation skipped: ${String(error)}`);
	}
}

function startExclusiveTimer(
	intervalMs: number,
	task: () => Promise<void>,
	errorContext: string,
): ReturnType<typeof setInterval> {
	let busy = false;
	return setInterval(() => {
		if (busy) return;
		busy = true;
		task()
			.catch((error) => log(`${errorContext}: ${String(error)}`))
			.finally(() => {
				busy = false;
			});
	}, intervalMs);
}

async function main(): Promise<void> {
	const config = loadConfig();
	const store = await initializeStore(config);
	await loadConfiguredTemplates(store, config.templateDir);
	const driver = createWorkspaceDriver(config);
	const storageDriver = createStorageDriver(config);
	const secretResolver = createSecretResolver(config);
	const { app, websocket, scheduler, persistence } = buildServer({
		store,
		driver,
		...(storageDriver ? { storageDriver } : {}),
		...(secretResolver ? { secretResolver } : {}),
		pepper: config.pepper,
		limits: config.limits,
		workspaceServerUrl: config.workspaceServerUrl,
		persistenceLimits: config.persistenceLimits,
		log,
	});

	await reconcileStartup(store, driver, storageDriver);

	const outbox = new OutboxDispatcher({
		store,
		sinkUrl: config.eventSinkUrl,
		sign: (timestamp, body) => signEvent(config.eventSigningKey, timestamp, body),
		onError: (context, err) => log(`${context}: ${String(err)}`),
	});

	const schedulerTimer = startExclusiveTimer(
		config.schedulerIntervalMs,
		() => scheduler.tick(),
		"scheduler tick failed",
	);
	const outboxTimer = startExclusiveTimer(
		config.outboxIntervalMs,
		() => outbox.tick(),
		"outbox tick failed",
	);
	const retentionTimer = startExclusiveTimer(
		60_000,
		async () => {
			const { deleted, skipped } = await persistence.pruneExpired();
			if (deleted > 0 || skipped > 0) {
				log(`retention: deleted=${deleted} skipped=${skipped}`);
			}
		},
		"retention sweep failed",
	);

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
		clearInterval(retentionTimer);
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
