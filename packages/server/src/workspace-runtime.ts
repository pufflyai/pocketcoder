import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import type { BuildDeps } from "./app";
import type { Hub } from "./control-channel/hub";
import { composeCheckpointRuntime } from "./persistence/checkpoint-runtime";
import { disposableSourceRuntime } from "./persistence/source-runtime";
import { createIssuerClient } from "./secrets/issuer-client";
import { createWorkspaceLeaseService } from "./secrets/lease-service";
import { createSecretVault } from "./secrets/secret-vault";

export function workspaceSecretFactory(pepper: string) {
  return { generate: generateOpaqueSecret, digest: (secret: string) => digestOpaque(pepper, secret) };
}

export function composeWorkspaceRuntime(deps: BuildDeps, hub: Hub) {
  const vault = deps.secretKey ? createSecretVault(deps.store, Buffer.from(deps.secretKey, "base64url")) : undefined;
  const workspaceLeases = vault
    ? createWorkspaceLeaseService({
        store: deps.store,
        vault,
        issuer: deps.issuerClient ?? createIssuerClient(),
        admissionFenced: () => deps.maintenance?.fenced ?? false,
      })
    : undefined;
  const checkpointRuntime = composeCheckpointRuntime(
    deps.store,
    hub,
    deps.driver,
    deps.storageDriver,
    deps.checkpointTransferOptions,
  );
  const { checkpointTransfers } = checkpointRuntime;
  const transferRuntime = checkpointRuntime.transferRuntime ?? sourceRuntime(deps);
  return { workspaceLeases, checkpointTransfers, transferRuntime };
}

function sourceRuntime(deps: BuildDeps) {
  if (deps.storageDriver) return;
  const kind = deps.driver.kind;
  if (kind === "docker" || kind === "kubernetes") return disposableSourceRuntime(kind);
}
