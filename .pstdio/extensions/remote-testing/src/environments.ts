import type { ExtensionStorageApi } from "@pstdio/sdk/extensions";
import type { Api } from "./connection";
import type { Settings } from "./settings";

// A test environment is one PocketCoder workspace of the configured template.
export interface Environment {
  id: string;
  external_id: string;
  state: string;
  reason_code: string | null;
  change_cursor: number;
  created_at: string;
  deadline_at: string | null;
  template: { name: string; version: string };
  metadata: Record<string, string>;
  failure: { log_tail: string } | null;
}

const PURPOSE = "remote-testing";
const ACTIVE = ["queued", "provisioning", "connected", "ready"];
const ENDED = ["succeeded", "failed", "canceled", "expired", "preserved"];
const path = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;

export async function listEnvironments(api: Api, settings: Settings) {
  const page = await api<{ items: Environment[] }>({
    method: "GET",
    path: `/v1/workspaces?template=${encodeURIComponent(settings.templateName)}&limit=100`,
  });
  return page.items.filter((item) => ACTIVE.includes(item.state) && item.metadata?.purpose === PURPOSE);
}

export async function createEnvironment(
  api: Api,
  settings: Settings,
  signal?: AbortSignal,
  metadata: Record<string, string> = {},
) {
  const purpose = metadata.purpose ?? PURPOSE;
  const externalId = `${purpose}-${crypto.randomUUID()}`;
  return api<Environment>({
    method: "POST",
    path: "/v1/workspaces",
    headers: { "Idempotency-Key": externalId },
    body: {
      external_id: externalId,
      template: { name: settings.templateName, version: settings.templateVersion },
      metadata: { ...metadata, purpose },
    },
    signal,
  });
}

export async function readEnvironment(api: Api, id: string, signal?: AbortSignal) {
  return api<Environment>({ method: "GET", path: path(id), signal });
}

export async function waitUntilReady(api: Api, environment: Environment, signal?: AbortSignal) {
  let current = environment;
  while (current.state !== "ready") {
    // A stopping environment reports its failure only once it has ended.
    if (ENDED.includes(current.state))
      throw new Error(
        `Environment ${current.id} is ${current.state}${current.reason_code ? ` (${current.reason_code})` : ""}. ${current.failure?.log_tail ?? ""}`.trim(),
      );
    signal?.throwIfAborted();
    const change = await api<{ workspace: Environment }>({
      method: "GET",
      path: `${path(current.id)}/changes?after=${current.change_cursor}&wait=30`,
      timeoutMs: 40_000,
      signal,
    });
    current = change.workspace;
  }
  return current;
}

export async function stopEnvironment(api: Api, id: string, signal?: AbortSignal) {
  return api<Environment>({ method: "POST", path: `${path(id)}/cancel`, signal });
}

type Claim = { runId: string; until: number };
const claimsOf = (store: ExtensionStorageApi) => store.collection<Claim>("environment-claims");

// Host claims are atomic on one host. The runner's filesystem lock also guards
// requests from other projects and devices, where shared record sync is not a lock.
export async function claimEnvironment(store: ExtensionStorageApi, id: string, runId: string, seconds: number) {
  const claims = claimsOf(store);
  const current = await claims.read(id);
  const next = { runId, until: Date.now() + seconds * 1000 };
  if (!current) return claims.createIfAbsent(id, next);
  if (current.value.runId !== runId && current.value.until > Date.now()) return false;
  return claims.updateIfUnchanged(id, current.revision, next);
}
export async function releaseEnvironment(store: ExtensionStorageApi, id: string, runId: string) {
  const claims = claimsOf(store);
  const claim = await claims.get(id);
  if (claim?.runId === runId) await claims.deleteIfValue(id, claim);
}
export async function activeRun(store: ExtensionStorageApi, id: string) {
  const claim = await claimsOf(store).get(id);
  return claim && claim.until > Date.now() ? claim.runId : null;
}

export async function isBusy(store: ExtensionStorageApi, id: string) {
  return Boolean(await activeRun(store, id));
}
