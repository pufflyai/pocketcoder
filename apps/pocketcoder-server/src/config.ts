import { randomBytes } from "node:crypto";
import { type AdmissionLimits, DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";

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
	driverKind: "docker";
	// Directory for workspace provider input files. When the server itself
	// runs in a container against the host Docker daemon, this must be a
	// host path mounted into the server at the same absolute path so the
	// daemon can resolve the bind mounts.
	inputDir: string | null;
	// URL workspaces use to reach this server; with the Docker driver on a
	// developer machine this is typically http://host.docker.internal:<port>.
	workspaceServerUrl: string;
	limits: AdmissionLimits;
	schedulerIntervalMs: number;
	outboxIntervalMs: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
	const raw = env[key];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
	const storeKind = env.POCKETCODER_STORE === "memory" ? "memory" : "postgres";
	const databaseUrl = env.POCKETCODER_DATABASE_URL ?? null;
	if (storeKind === "postgres" && !databaseUrl) {
		throw new Error(
			"POCKETCODER_DATABASE_URL is required (or set POCKETCODER_STORE=memory for development)",
		);
	}
	let pepper = env.POCKETCODER_AUTH_PEPPER ?? "";
	if (!pepper) {
		if (storeKind === "postgres") {
			throw new Error("POCKETCODER_AUTH_PEPPER is required with the postgres store");
		}
		// Ephemeral pepper is acceptable only for the in-memory dev store,
		// where keys do not outlive the process anyway.
		pepper = randomBytes(32).toString("base64url");
	}
	const listenPort = intEnv(env, "POCKETCODER_PORT", 7080);
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
		driverKind: "docker",
		inputDir: env.POCKETCODER_INPUT_DIR ?? null,
		workspaceServerUrl:
			env.POCKETCODER_WORKSPACE_SERVER_URL ?? `http://host.docker.internal:${listenPort}`,
		limits: {
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
		},
		schedulerIntervalMs: intEnv(env, "POCKETCODER_SCHEDULER_INTERVAL_MS", 1000),
		outboxIntervalMs: intEnv(env, "POCKETCODER_OUTBOX_INTERVAL_MS", 1000),
	};
}
