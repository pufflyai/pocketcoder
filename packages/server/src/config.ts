import { randomBytes } from "node:crypto";
import { parseDurationMs } from "@pstdio/pocketcoder-contracts";
import {
  type AdmissionLimits,
  DEFAULT_LIMITS,
  type WarmPoolConfigEntry,
} from "@pstdio/pocketcoder-runtime-core";
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
  egressImage: string | null;
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
  warmPools: WarmPoolConfigEntry[];
}

function resolveWarmPools(env: Environment): WarmPoolConfigEntry[] {
  const raw = env.POCKETCODER_WARM_POOLS;
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("POCKETCODER_WARM_POOLS must be valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("POCKETCODER_WARM_POOLS must be a JSON array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object")
      throw new Error(`POCKETCODER_WARM_POOLS[${index}] must be an object`);
    const entry = item as Record<string, unknown>;
    if (typeof entry.template !== "string" || !entry.template)
      throw new Error(`POCKETCODER_WARM_POOLS[${index}].template is required`);
    const minReady = entry.min_ready === undefined ? 1 : Number(entry.min_ready);
    if (!Number.isInteger(minReady) || minReady <= 0)
      throw new Error(`POCKETCODER_WARM_POOLS[${index}].min_ready must be a positive integer`);
    const missPolicy = entry.miss_policy ?? "cold";
    if (missPolicy !== "cold" && missPolicy !== "wait")
      throw new Error(`POCKETCODER_WARM_POOLS[${index}].miss_policy must be cold or wait`);
    const duration = (key: string, fallback: string) => {
      const candidate = entry[key] ?? fallback;
      if (typeof candidate !== "string")
        throw new Error(`POCKETCODER_WARM_POOLS[${index}].${key} must be a duration`);
      try {
        return parseDurationMs(candidate);
      } catch {
        throw new Error(`POCKETCODER_WARM_POOLS[${index}].${key} must be a duration`);
      }
    };
    return {
      template: entry.template,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      minReady,
      maxWarmAgeMs: duration("max_warm_age", "15m"),
      missPolicy,
      waitTimeoutMs: duration("wait_timeout", "5s"),
    };
  });
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

function enumEnv<const T extends readonly string[]>(
  env: Environment,
  key: string,
  values: T,
  fallback: T[number],
): T[number] {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!values.includes(raw)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return raw as T[number];
}

function httpUrlEnv(env: Environment, key: string, fallback: string | null): string | null {
  const value = env[key] ?? fallback;
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must be a valid HTTP(S) URL`);
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
  const storeKind = enumEnv(env, "POCKETCODER_STORE", ["postgres", "memory"] as const, "postgres");
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
  const storageBackend = enumEnv(
    env,
    "POCKETCODER_STORAGE_BACKEND",
    ["disabled", "filesystem", "kubernetes-pvc"] as const,
    "disabled",
  );
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
  const secretProvider = enumEnv(
    env,
    "POCKETCODER_SECRET_PROVIDER",
    ["disabled", "file", "kubernetes"] as const,
    "disabled",
  );
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

function assertCompatibleBackends(
  driverKind: ServerConfig["driverKind"],
  storage: ReturnType<typeof resolveStorage>,
  secrets: ReturnType<typeof resolveSecrets>,
): void {
  if (driverKind === "docker" && storage.storageBackend === "kubernetes-pvc") {
    throw new Error("POCKETCODER_DRIVER=docker cannot use kubernetes-pvc storage");
  }
  if (driverKind === "kubernetes" && storage.storageBackend === "filesystem") {
    throw new Error("POCKETCODER_STORAGE_BACKEND=filesystem cannot be used with Kubernetes");
  }
  if (driverKind === "docker" && secrets.secretProvider === "kubernetes") {
    throw new Error("POCKETCODER_DRIVER=docker cannot use the Kubernetes secret provider");
  }
  if (driverKind === "kubernetes" && secrets.secretProvider === "file") {
    throw new Error("POCKETCODER_SECRET_PROVIDER=file cannot be used with Kubernetes");
  }
}

export function configSummary(config: ServerConfig) {
  return {
    listen: `${config.listenHost}:${config.listenPort}`,
    store: config.storeKind,
    databaseSchema: config.storeKind === "postgres" ? config.databaseSchema : null,
    driver: config.driverKind,
    storage: config.storageBackend,
    secrets: config.secretProvider,
    persistenceEnabled: config.storageBackend !== "disabled",
    warmPoolCount: config.warmPools.length,
  };
}

export function loadConfig(env: Environment = process.env): ServerConfig {
  const { storeKind, databaseUrl } = resolveStore(env);
  const pepper = resolvePepper(env, storeKind);
  const listenPort = intEnv(env, "POCKETCODER_PORT", 7080);
  if (listenPort > 65_535) throw new Error("POCKETCODER_PORT must be at most 65535");
  const driverKind = enumEnv(
    env,
    "POCKETCODER_DRIVER",
    ["docker", "kubernetes"] as const,
    "docker",
  );
  const kubernetesNamespace = env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
  const storage = resolveStorage(env);
  const secrets = resolveSecrets(env);
  assertCompatibleBackends(driverKind, storage, secrets);
  const egressImage = env.POCKETCODER_EGRESS_IMAGE ?? null;
  if (egressImage && !/@sha256:[0-9a-f]{64}$/.test(egressImage)) {
    throw new Error("POCKETCODER_EGRESS_IMAGE must be an immutable sha256 digest reference");
  }
  return {
    listenHost: env.POCKETCODER_HOST ?? "127.0.0.1",
    listenPort,
    storeKind,
    databaseUrl,
    databaseSchema: env.POCKETCODER_DATABASE_SCHEMA ?? "pocketcoder",
    pepper,
    eventSigningKey: env.POCKETCODER_EVENT_SIGNING_KEY ?? pepper,
    eventSinkUrl: httpUrlEnv(env, "POCKETCODER_EVENT_SINK_URL", null),
    egressImage,
    templateDir: env.POCKETCODER_TEMPLATE_DIR ?? null,
    driverKind,
    inputDir: env.POCKETCODER_INPUT_DIR ?? null,
    ...storage,
    ...secrets,
    kubernetesNamespace,
    kubernetesServiceAccount: env.POCKETCODER_KUBERNETES_SERVICE_ACCOUNT ?? null,
    kubernetesWorkspaceSubPath: env.POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH ?? "workspaces",
    workspaceServerUrl: httpUrlEnv(
      env,
      "POCKETCODER_WORKSPACE_SERVER_URL",
      driverKind === "kubernetes"
        ? `http://pocketcoder-server.${kubernetesNamespace}.svc:${listenPort}`
        : `http://host.docker.internal:${listenPort}`,
    ) as string,
    limits: resolveAdmissionLimits(env),
    schedulerIntervalMs: intEnv(env, "POCKETCODER_SCHEDULER_INTERVAL_MS", 1000),
    outboxIntervalMs: intEnv(env, "POCKETCODER_OUTBOX_INTERVAL_MS", 1000),
    persistenceLimits: resolvePersistenceLimits(env),
    warmPools: resolveWarmPools(env),
  };
}
