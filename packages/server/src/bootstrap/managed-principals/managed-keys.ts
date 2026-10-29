import { randomUUID } from "node:crypto";
import { parseMachineKey, verifySecret } from "@pstdio/pocketcoder-auth";
import {
  type AuthStore,
  issuePrincipalKey,
  type MachineKeyRow,
  type PrincipalRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { ManagedPrincipal } from "./principal-file";
import { desiredGrants } from "./principal-plan";
import type { SecretTargetStore } from "./secret-targets";

const HOUR = 3_600_000;
const MANAGED_REQUEST_PREFIX = "managed-";

export interface KeyChange {
  action: "keep" | "issue";
  reason: "healthy" | "missing" | "unknown_key" | "pepper_changed" | "revoked" | "expiring" | "grants_changed";
  keyId: string | null;
  retired: string[];
}

const same = (left: string[], right: string[]) => left.join("\n") === right.join("\n");

// The target is the source of truth: the controller never stores tokens, so it checks the
// token it wrote earlier. A pepper rotation makes that check fail, which re-issues the key.
async function inspectTarget(
  store: AuthStore,
  pepper: string,
  principal: ManagedPrincipal & { id: string },
  target: SecretTargetStore,
  now: Date,
): Promise<{ reason: KeyChange["reason"]; key?: MachineKeyRow }> {
  const token = await target.read();
  const parsed = token ? parseMachineKey(token) : null;
  if (!parsed) return { reason: "missing" };
  const found = await store.getMachineKeyWithPrincipal(parsed.id);
  if (!found || found.key.principalId !== principal.id) return { reason: "unknown_key" };
  const { key } = found;
  if (!verifySecret(pepper, parsed.id, parsed.secret, key.secretDigest)) return { reason: "pepper_changed" };
  if (key.revokedAt) return { reason: "revoked" };
  const renewBefore = (principal.key?.renew_before_hours ?? 0) * HOUR;
  if (!key.expiresAt || key.expiresAt.getTime() - now.getTime() <= renewBefore) return { reason: "expiring" };
  const desired = desiredGrants(principal);
  if (!same(key.scopes, desired.scopes) || !same(key.templateNames ?? [], desired.templateNames)) {
    return { reason: "grants_changed" };
  }
  return { reason: "healthy", key };
}

async function principalKeys(store: AuthStore, principalId: string) {
  const keys: MachineKeyRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listMachineKeys(principalId, { limit: 100, ...(cursor ? { cursor } : {}) });
    keys.push(...page);
    cursor = page.length === 100 ? page.at(-1)?.id : undefined;
  } while (cursor);
  return keys;
}

// Earlier managed keys stay valid for the overlap window so consumers can reload the target.
async function retireSuperseded(
  store: AuthStore,
  current: MachineKeyRow,
  overlapMs: number,
  now: Date,
  dryRun: boolean,
) {
  if (current.createdAt.getTime() + overlapMs > now.getTime()) return [];
  const superseded = (await principalKeys(store, current.principalId)).filter(
    (key) => key.id !== current.id && !key.revokedAt && key.issuanceRequestId?.startsWith(MANAGED_REQUEST_PREFIX),
  );
  if (!dryRun) for (const key of superseded) await store.revokeMachineKey(key.id, now);
  return superseded.map((key) => key.id);
}

export async function ensureManagedKey(input: {
  store: AuthStore;
  pepper: string;
  principal: PrincipalRow;
  config: ManagedPrincipal;
  target: SecretTargetStore;
  now: Date;
  dryRun: boolean;
}): Promise<KeyChange> {
  const { store, pepper, principal, config, target, now, dryRun } = input;
  const settings = config.key;
  if (!settings) throw new Error(`principal ${config.name} declares no key`);
  const inspected = await inspectTarget(store, pepper, { ...config, id: principal.id }, target, now);
  if (inspected.key) {
    const retired = await retireSuperseded(store, inspected.key, settings.overlap_minutes * 60_000, now, dryRun);
    return { action: "keep", reason: "healthy", keyId: inspected.key.id, retired };
  }
  if (dryRun) return { action: "issue", reason: inspected.reason, keyId: null, retired: [] };
  const desired = desiredGrants(config);
  const issued = await issuePrincipalKey(
    store,
    pepper,
    principal,
    {
      request_id: `${MANAGED_REQUEST_PREFIX}${randomUUID()}`,
      scopes: desired.scopes as never,
      templates: desired.templateNames,
      expires_at: new Date(now.getTime() + settings.lifetime_hours * HOUR).toISOString(),
    },
    { operatorBootstrap: true },
  );
  try {
    await target.write(issued.token as string);
  } catch (error) {
    // A token nobody received must not stay valid.
    await store.revokeMachineKey(issued.key.id, new Date());
    throw error;
  }
  return { action: "issue", reason: inspected.reason, keyId: issued.key.id, retired: [] };
}
