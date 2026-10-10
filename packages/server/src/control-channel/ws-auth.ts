import { verifyOpaque } from "@pstdio/pocketcoder-auth";
import {
  agentApiHarness,
  CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION,
  type ExecSpec,
  errorEnvelope,
  HEADER_PROTOCOL,
  HEADER_RECONNECT,
  HEADER_REGISTRATION,
  HEADER_WORKSPACE,
  isAgentApiNative,
  isTerminal,
  type ProtocolVersion,
  parseDurationMs,
  type RestoreMode,
  RUNTIME_CREDENTIAL_MIN_PROTOCOL_VERSION,
  runtimeCredentialPath,
  runtimeCredentialReferences,
  SOURCE_CREDENTIAL_MIN_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  snapshotServices,
  TERMINAL_REPLAY_BUFFER_BYTES,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/middleware";
import type { WsAuth, WsDeps } from "./ws-types";

interface WsCredentials {
  protocolVersion: number;
  workspaceId: string;
  registration?: string;
  reconnect?: string;
}

type WsAuthResult = { auth: WsAuth } | { error: string };

export function sourceCredentialReference(row: WorkspaceRow): string | null {
  if (row.launchMode !== "create" || !row.sourceDescriptor) return null;
  return row.templateSnapshot.spec.source?.repositories[row.sourceDescriptor.repository]?.credential ?? null;
}

function validRegistration(deps: WsDeps, row: WorkspaceRow, secret: string): boolean {
  return (
    row.state === "provisioning" &&
    row.registrationDigest !== null &&
    row.registrationExpiresAt !== null &&
    row.registrationExpiresAt > new Date() &&
    verifyOpaque(deps.pepper, secret, row.registrationDigest)
  );
}

function validReconnect(deps: WsDeps, row: WorkspaceRow, secret: string): boolean {
  return (
    ["connected", "ready", "preserving", "terminating"].includes(row.state) &&
    row.reconnectDigest !== null &&
    verifyOpaque(deps.pepper, secret, row.reconnectDigest)
  );
}

async function authenticateConnection(deps: WsDeps, credentials: WsCredentials): Promise<WsAuthResult> {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(credentials.protocolVersion as ProtocolVersion)) {
    return { error: "Unsupported agent protocol version." };
  }
  if (!credentials.workspaceId || (!credentials.registration && !credentials.reconnect)) {
    return { error: "Missing workspace credentials." };
  }
  const row = await deps.store.getWorkspace(credentials.workspaceId);
  if (
    row &&
    runtimeCredentialReferences(row.templateSnapshot.spec).length &&
    credentials.protocolVersion < RUNTIME_CREDENTIAL_MIN_PROTOCOL_VERSION
  )
    return { error: "Runtime credentials require agent protocol version 9." };
  if (!row || row.purgeRequestedAt || isTerminal(row.state)) return { error: "Unknown workspace." };
  if (
    deps.checkpointTransfers &&
    row.launchMode === "restore" &&
    credentials.protocolVersion < CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION
  ) {
    return { error: "Checkpoint restore requires agent protocol version 7." };
  }
  if (sourceCredentialReference(row) && credentials.protocolVersion < SOURCE_CREDENTIAL_MIN_PROTOCOL_VERSION) {
    return { error: "Source credentials require agent protocol version 8." };
  }
  if (credentials.registration) {
    if (!validRegistration(deps, row, credentials.registration)) {
      return { error: "Invalid or expired registration secret." };
    }
    return {
      auth: {
        workspaceId: credentials.workspaceId,
        mode: "register",
        protocolVersion: credentials.protocolVersion as ProtocolVersion,
      },
    };
  }
  if (!validReconnect(deps, row, credentials.reconnect ?? "")) {
    return { error: "Invalid reconnect credential." };
  }
  return {
    auth: {
      workspaceId: credentials.workspaceId,
      mode: "reconnect",
      protocolVersion: credentials.protocolVersion as ProtocolVersion,
    },
  };
}

export function agentConnectValidator(deps: WsDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reject = (message: string) =>
      c.json(errorEnvelope("auth.invalid_key", message, c.get("requestId") ?? ""), 401);
    const result = await authenticateConnection(deps, {
      protocolVersion: Number(c.req.header(HEADER_PROTOCOL)),
      workspaceId: c.req.header(HEADER_WORKSPACE) ?? "",
      ...(c.req.header(HEADER_REGISTRATION) ? { registration: c.req.header(HEADER_REGISTRATION) } : {}),
      ...(c.req.header(HEADER_RECONNECT) ? { reconnect: c.req.header(HEADER_RECONNECT) } : {}),
    });
    if ("error" in result) return reject(result.error);
    c.set("wsAuth" as never, result.auth as never);
    await next();
  };
}

export function execSpecOf(row: WorkspaceRow, sourceCredential: string | null, restoreMode: RestoreMode): ExecSpec {
  const spec = row.templateSnapshot.spec;
  const sourceSpec = spec.source;
  const sourceRepository =
    sourceSpec && row.sourceDescriptor ? sourceSpec.repositories[row.sourceDescriptor.repository] : undefined;
  const sourceMount = sourceSpec && spec.persistence.mounts.find((mount) => mount.name === sourceSpec.destinationMount);
  const harness = agentApiHarness(spec);
  const native = isAgentApiNative(spec);
  return {
    agentapi_native: native,
    setup: spec.setup
      .filter((step) => step.runOn.includes(row.launchMode))
      .map((step) => ({ ...step, env: materializeSecretEnv(step.env) })),
    harness: { ...harness, env: materializeSecretEnv(harness.env) },
    env: materializeSecretEnv(spec.env),
    services: snapshotServices(row.templateSnapshot),
    previews: spec.previews,
    terminal: spec.terminal
      ? {
          command: spec.terminal.command,
          env: materializeSecretEnv(spec.terminal.env),
          ...(spec.terminal.cwd ? { cwd: spec.terminal.cwd } : {}),
          max_sessions: spec.terminal.maxSessions,
          idle_timeout_seconds: Math.ceil(parseDurationMs(spec.terminal.idleTimeout) / 1000),
          replay_buffer_bytes: TERMINAL_REPLAY_BUFFER_BYTES,
        }
      : null,
    timeouts: spec.timeouts,
    security: { writable_memory_paths: spec.security.writableMemoryPaths },
    network:
      spec.network.mode === "restricted"
        ? {
            mode: "restricted",
            proxy_url: "http://127.0.0.1:18080",
            health_url: "http://127.0.0.1:18082/healthz",
          }
        : { mode: "unrestricted" },
    launch_mode: row.launchMode,
    source:
      row.sourceDescriptor && sourceRepository && sourceMount
        ? {
            ...row.sourceDescriptor,
            url: sourceRepository.url,
            destination: sourceMount.target,
            max_bytes: sourceMount.maxBytes,
            max_files: sourceMount.maxFiles,
            credential: sourceCredential,
            credential_expires_at: null,
          }
        : null,
    restore:
      row.restoredFromCheckpointId && row.originWorkspaceId
        ? {
            mode: restoreMode,
            checkpoint_id: row.restoredFromCheckpointId,
            origin_workspace_id: row.originWorkspaceId,
            transfer: null,
          }
        : null,
    persistence: {
      mounts: spec.persistence.mounts.map(({ name, target }) => ({ name, target })),
      conversation_restore: row.persistenceCapability,
    },
    checkpoint_hook:
      !native && spec.checkpointHook
        ? {
            command: spec.checkpointHook.command,
            timeout_seconds: spec.checkpointHook.timeoutSeconds,
            env: materializeSecretEnv(spec.checkpointHook.env),
            ...(spec.checkpointHook.cwd ? { cwd: spec.checkpointHook.cwd } : {}),
          }
        : null,
    outputs: spec.outputs,
  };
}

export async function sourceCredentialFor(deps: WsDeps, row: WorkspaceRow) {
  const reference = sourceCredentialReference(row);
  if (!reference) return null;
  if (!deps.workspaceLeases) throw new Error("No setup issuer is configured.");
  const previous = (await deps.store.listPendingWorkspaceLeases(row.id)).find(
    (lease) => lease.secretName === reference.slice(10),
  );
  return previous
    ? deps.workspaceLeases.replay(row.id, previous.id)
    : deps.workspaceLeases.issue(row.id, reference.slice(10), "setup-issuer");
}

function materializeSecretEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.startsWith("secretRef:") ? runtimeCredentialPath(value) : value,
    ]),
  );
}
