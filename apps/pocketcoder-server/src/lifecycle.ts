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

export type ServerLog = (message: string) => void;

export interface RunningPocketcoderServer {
	config: ServerConfig;
	url: string;
	stop(): Promise<void>;
}

const defaultLog: ServerLog = (message) => console.log(`[pocketcoder-server] ${message}`);

async function initializeStore(config: ServerConfig, log: ServerLog): Promise<Store> {
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

async function loadConfiguredTemplates(
	store: Store,
	templateDir: string | null,
	log: ServerLog,
): Promise<void> {
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
	log: ServerLog,
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
	log: ServerLog,
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

export async function startPocketcoderServer(
	config: ServerConfig = loadConfig(),
	options: { log?: ServerLog; instanceId?: string } = {},
): Promise<RunningPocketcoderServer> {
	const log = options.log ?? defaultLog;
	const store = await initializeStore(config, log);
	try {
		await loadConfiguredTemplates(store, config.templateDir, log);
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
			...(options.instanceId ? { instanceId: options.instanceId } : {}),
			log,
		});

		await reconcileStartup(store, driver, storageDriver, log);

		const outbox = new OutboxDispatcher({
			store,
			sinkUrl: config.eventSinkUrl,
			sign: (timestamp, body) => signEvent(config.eventSigningKey, timestamp, body),
			onError: (context, error) => log(`${context}: ${String(error)}`),
		});

		const schedulerTimer = startExclusiveTimer(
			config.schedulerIntervalMs,
			() => scheduler.tick(),
			"scheduler tick failed",
			log,
		);
		const outboxTimer = startExclusiveTimer(
			config.outboxIntervalMs,
			() => outbox.tick(),
			"outbox tick failed",
			log,
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
			log,
		);

		let server: ReturnType<typeof Bun.serve>;
		try {
			server = Bun.serve({
				hostname: config.listenHost,
				port: config.listenPort,
				fetch: app.fetch,
				websocket,
			});
		} catch (error) {
			clearInterval(schedulerTimer);
			clearInterval(outboxTimer);
			clearInterval(retentionTimer);
			throw error;
		}

		const healthHost =
			config.listenHost === "0.0.0.0" || config.listenHost === "::"
				? "127.0.0.1"
				: config.listenHost;
		const url = `http://${healthHost}:${server.port}`;
		log(`listening on http://${config.listenHost}:${server.port}`);
		log(`workspaces reach this server at ${config.workspaceServerUrl}`);

		let stopPromise: Promise<void> | null = null;
		return {
			config,
			url,
			stop() {
				if (stopPromise) return stopPromise;
				stopPromise = (async () => {
					log("shutting down");
					clearInterval(schedulerTimer);
					clearInterval(outboxTimer);
					clearInterval(retentionTimer);
					await server.stop(true);
					await store.close();
				})();
				return stopPromise;
			},
		};
	} catch (error) {
		await store.close().catch(() => {});
		throw error;
	}
}

export async function runPocketcoderServerUntilSignal(
	config: ServerConfig = loadConfig(),
	options: { log?: ServerLog; instanceId?: string } = {},
): Promise<void> {
	const running = await startPocketcoderServer(config, options);
	await new Promise<void>((resolve, reject) => {
		let stopping = false;
		const shutdown = () => {
			if (stopping) return;
			stopping = true;
			running.stop().then(resolve, reject);
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}
