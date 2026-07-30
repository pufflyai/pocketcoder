import { randomBytes } from "node:crypto";
import { type AdmissionLimits, DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { DEFAULT_PERSISTENCE_LIMITS, type PersistenceLimits } from "./persistence";

type Environment = Record<string, string | undefined>;

export interface ServerConfig {
	listenHost: string;
	listenPort: number;
	storeKind: "postgres" | "memory";
	databaseUrl: string | null;
	databaseSchema: string;
	pepper: string;
	eventSigningKey: string;
	eventSinkUrl: string | null;
	templateDir: string | null;
	driverKind: "docker" | "kubernetes";
	// Directory for workspace provider input files. When the server itself
	// runs in a container against the host Docker daemon, this must be a
	// host path mounted into the server at the same absolute path so the
	// daemon can resolve the bind mounts.
	inputDir: string | null;
	storageBackend: "disabled" | "filesystem" | "kubernetes-pvc";
	workspaceDataDir: string | null;
	checkpointDir: string | null;
	secretProvider: "disabled" | "file" | "kubernetes";
	secretRoot: string | null;
	kubernetesNamespace: string;
	kubernetesServiceAccount: string | null;
	kubernetesWorkspaceClaim: string | null;
	kubernetesWorkspaceSubPath: string;
	// URL workspaces use to reach this server; with the Docker driver on a
	// developer machine this is typically http://host.docker.internal:<port>.
	workspaceServerUrl: string;
	limits: AdmissionLimits;
	schedulerIntervalMs: number;
	outboxIntervalMs: number;
	persistenceLimits: PersistenceLimits;
}

function intEnv(env: Environment, key: string, fallback: number): number {
	const raw = env[key];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value;
}

function bytesEnv(env: Environment, key: string, fallback: number): number {
	const raw = env[key];
	if (!raw) return fallback;
	const match = /^(\d+)(Ki|Mi|Gi|Ti)?$/i.exec(raw);
	if (!match) throw new Error(`${key} must be bytes or a Ki/Mi/Gi/Ti value`);
	const unit = (match[2] ?? "").toLowerCase();
	const multipliers: Record<string, number> = {
		ki: 1024,
		mi: 1024 ** 2,
		gi: 1024 ** 3,
		ti: 1024 ** 4,
	};
	const multiplier = multipliers[unit] ?? 1;
	const value = Number(match[1]) * multiplier;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${key} is outside the supported byte range`);
	}
	return value;
}

function resolveStore(env: Environment): Pick<ServerConfig, "storeKind" | "databaseUrl"> {
	const storeKind = env.POCKETCODER_STORE === "memory" ? "memory" : "postgres";
	const databaseUrl = env.POCKETCODER_DATABASE_URL ?? null;
	if (storeKind === "postgres" && !databaseUrl) {
		throw new Error(
			"POCKETCODER_DATABASE_URL is required (or set POCKETCODER_STORE=memory for development)",
		);
	}
	return { storeKind, databaseUrl };
}

function resolvePepper(env: Environment, storeKind: ServerConfig["storeKind"]): string {
	let pepper = env.POCKETCODER_AUTH_PEPPER ?? "";
	if (!pepper) {
		if (storeKind === "postgres") {
			throw new Error("POCKETCODER_AUTH_PEPPER is required with the postgres store");
		}
		// Ephemeral pepper is acceptable only for the in-memory dev store,
		// where keys do not outlive the process anyway.
		pepper = randomBytes(32).toString("base64url");
	}
	return pepper;
}

function resolveStorage(
	env: Environment,
): Pick<
	ServerConfig,
	"storageBackend" | "workspaceDataDir" | "checkpointDir" | "kubernetesWorkspaceClaim"
> {
	const storageBackend =
		env.POCKETCODER_STORAGE_BACKEND === "kubernetes-pvc"
			? "kubernetes-pvc"
			: env.POCKETCODER_STORAGE_BACKEND === "filesystem" ||
					env.POCKETCODER_STORAGE_BACKEND === "docker-local"
				? "filesystem"
				: "disabled";
	const workspaceDataDir = env.POCKETCODER_WORKSPACE_DATA_DIR ?? null;
	const checkpointDir = env.POCKETCODER_CHECKPOINT_DIR ?? null;
	if (storageBackend === "filesystem" && (!workspaceDataDir || !checkpointDir)) {
		throw new Error(
			"POCKETCODER_WORKSPACE_DATA_DIR and POCKETCODER_CHECKPOINT_DIR are required when persistent storage is enabled",
		);
	}
	if (storageBackend === "kubernetes-pvc" && (!workspaceDataDir || !checkpointDir)) {
		throw new Error(
			"the Kubernetes PVC must be mounted into the server at POCKETCODER_WORKSPACE_DATA_DIR and POCKETCODER_CHECKPOINT_DIR",
		);
	}
	if (storageBackend === "kubernetes-pvc" && !env.POCKETCODER_KUBERNETES_WORKSPACE_CLAIM) {
		throw new Error(
			"POCKETCODER_KUBERNETES_WORKSPACE_CLAIM is required for kubernetes-pvc storage",
		);
	}
	return {
		storageBackend,
		workspaceDataDir,
		checkpointDir,
		kubernetesWorkspaceClaim: env.POCKETCODER_KUBERNETES_WORKSPACE_CLAIM ?? null,
	};
}

function resolveSecrets(env: Environment): Pick<ServerConfig, "secretProvider" | "secretRoot"> {
	const secretProvider: ServerConfig["secretProvider"] =
		env.POCKETCODER_SECRET_PROVIDER === "file"
			? "file"
			: env.POCKETCODER_SECRET_PROVIDER === "kubernetes"
				? "kubernetes"
				: "disabled";
	const secretRoot = env.POCKETCODER_SECRET_ROOT ?? null;
	if (secretProvider === "file" && !secretRoot) {
		throw new Error("POCKETCODER_SECRET_ROOT is required for the file secret provider");
	}
	return { secretProvider, secretRoot };
}

function resolveAdmissionLimits(env: Environment): AdmissionLimits {
	return {
		...DEFAULT_LIMITS,
		globalActiveWorkspaces: intEnv(
			env,
			"POCKETCODER_MAX_ACTIVE_WORKSPACES",
			DEFAULT_LIMITS.globalActiveWorkspaces,
		),
		perPrincipalActiveWorkspaces: intEnv(
			env,
			"POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL",
			DEFAULT_LIMITS.perPrincipalActiveWorkspaces,
		),
		maxQueuedWorkspaces: intEnv(
			env,
			"POCKETCODER_MAX_QUEUED_WORKSPACES",
			DEFAULT_LIMITS.maxQueuedWorkspaces,
		),
	};
}

function resolvePersistenceLimits(env: Environment): PersistenceLimits {
	return {
		maxRetainedBytes: bytesEnv(
			env,
			"POCKETCODER_MAX_RETAINED_BYTES",
			DEFAULT_PERSISTENCE_LIMITS.maxRetainedBytes,
		),
		maxRetainedBytesPerPrincipal: bytesEnv(
			env,
			"POCKETCODER_MAX_RETAINED_BYTES_PER_PRINCIPAL",
			DEFAULT_PERSISTENCE_LIMITS.maxRetainedBytesPerPrincipal,
		),
		maxCheckpointsPerPrincipal: intEnv(
			env,
			"POCKETCODER_MAX_CHECKPOINTS_PER_PRINCIPAL",
			DEFAULT_PERSISTENCE_LIMITS.maxCheckpointsPerPrincipal,
		),
		maxCheckpointFiles: intEnv(
			env,
			"POCKETCODER_MAX_CHECKPOINT_FILES",
			DEFAULT_PERSISTENCE_LIMITS.maxCheckpointFiles,
		),
		maxConcurrentOperations: intEnv(
			env,
			"POCKETCODER_MAX_CHECKPOINT_OPERATIONS",
			DEFAULT_PERSISTENCE_LIMITS.maxConcurrentOperations,
		),
	};
}

export function loadConfig(env: Environment = process.env): ServerConfig {
	const { storeKind, databaseUrl } = resolveStore(env);
	const pepper = resolvePepper(env, storeKind);
	const listenPort = intEnv(env, "POCKETCODER_PORT", 7080);
	const driverKind = env.POCKETCODER_DRIVER === "kubernetes" ? "kubernetes" : "docker";
	const kubernetesNamespace = env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
	const storage = resolveStorage(env);
	const secrets = resolveSecrets(env);
	return {
		listenHost: env.POCKETCODER_HOST ?? "127.0.0.1",
		listenPort,
		storeKind,
		databaseUrl,
		databaseSchema: env.POCKETCODER_DATABASE_SCHEMA ?? "pocketcoder",
		pepper,
		eventSigningKey: env.POCKETCODER_EVENT_SIGNING_KEY ?? pepper,
		eventSinkUrl: env.POCKETCODER_EVENT_SINK_URL ?? null,
		templateDir: env.POCKETCODER_TEMPLATE_DIR ?? null,
		driverKind,
		inputDir: env.POCKETCODER_INPUT_DIR ?? null,
		...storage,
		...secrets,
		kubernetesNamespace,
		kubernetesServiceAccount: env.POCKETCODER_KUBERNETES_SERVICE_ACCOUNT ?? null,
		kubernetesWorkspaceSubPath: env.POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH ?? "workspaces",
		workspaceServerUrl:
			env.POCKETCODER_WORKSPACE_SERVER_URL ??
			(driverKind === "kubernetes"
				? `http://pocketcoder-server.${kubernetesNamespace}.svc:${listenPort}`
				: `http://host.docker.internal:${listenPort}`),
		limits: resolveAdmissionLimits(env),
		schedulerIntervalMs: intEnv(env, "POCKETCODER_SCHEDULER_INTERVAL_MS", 1000),
		outboxIntervalMs: intEnv(env, "POCKETCODER_OUTBOX_INTERVAL_MS", 1000),
		persistenceLimits: resolvePersistenceLimits(env),
	};
}
