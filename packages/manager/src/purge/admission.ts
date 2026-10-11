import { randomUUID } from "node:crypto";
import { ManagerError } from "../accounts/errors";
import type { ManagerStore } from "../database/store";
import type { PurgeAuthority } from "./authority";
import { createRequestDigest, type PurgeIntent, purgeRequestDigest } from "./intent";

export const purgeOperation = (intent: PurgeIntent) => ({
  id: intent.operationId,
  account_id: intent.accountId,
  kind: "purge" as const,
  state: "pending" as const,
});

export function purgeAdmission(store: ManagerStore, authority: PurgeAuthority) {
  const pending = new Map<string, Promise<ReturnType<typeof purgeOperation>>>();
  async function admit(accountId: string, requestId: string, expiresAt: Date) {
    await authority.refresh();
    if (expiresAt <= new Date() || !Number.isFinite(expiresAt.getTime())) throw new ManagerError(401, "unauthorized");
    const prior = authority.account(accountId);
    const digest = purgeRequestDigest(requestId);
    if (prior) {
      if (prior.purgeRequestDigest !== digest) throw new ManagerError(409, "idempotency_conflict");
      await authority.acknowledge(prior);
      return purgeOperation(prior);
    }
    const account = await store.getAccount(accountId);
    if (!account) throw new ManagerError(404, "account_not_found");
    const intent: PurgeIntent = {
      format: "pocketcoder-account-purge/v1",
      accountId,
      operationId: randomUUID(),
      createRequestDigest: createRequestDigest(account.requestId),
      purgeRequestDigest: digest,
      admittedAt: new Date().toISOString(),
    };
    await authority.acknowledge(intent);
    return purgeOperation(intent);
  }
  return async (accountId: string, requestId: string, expiresAt: Date) => {
    const previous = pending.get(accountId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => admit(accountId, requestId, expiresAt));
    pending.set(accountId, current);
    try {
      return await current;
    } finally {
      if (pending.get(accountId) === current) pending.delete(accountId);
    }
  };
}
