import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { ManagerContext } from "../database/context";
import { provisionIdentities } from "../database/provision-identities";
import { purgeErasure } from "../database/purge-erasure";
import type { discoverPurgeNamespaces } from "../kubernetes/purge-namespaces";
import { purgeOperation } from "./admission";
import type { PurgeAuthority } from "./authority";
import type { PurgeIntent } from "./intent";
import { PurgeTargets } from "./physical-state";
import { createPurgeProgress } from "./progress";

type Discover = (intent: PurgeIntent) => ReturnType<typeof discoverPurgeNamespaces>;
type Physical = (intent: PurgeIntent, target: { accountId: string; namespaceUid: string }) => Promise<boolean>;
type Targets = z.infer<typeof PurgeTargets>;
function requireSameIds(current: Targets, saved: Targets) {
  if (
    !isDeepStrictEqual(
      current.map((target) => target.accountId),
      saved.map((target) => target.accountId),
    )
  )
    throw new Error("Purge target inventory changed.");
}
function requireObserved(current: Targets, saved: Targets) {
  requireSameIds(current, saved);
  for (const target of saved) {
    const observed = current.find((entry) => entry.accountId === target.accountId);
    if (
      !observed ||
      (observed.namespaceUid && observed.namespaceUid !== target.namespaceUid) ||
      (target.neverStarted && !observed.neverStarted)
    )
      throw new Error("Purge target identity changed.");
  }
}
function requireFinal(current: Targets, saved: Targets) {
  requireSameIds(current, saved);
  if (
    current.some(
      (target) =>
        target.namespaceUid ||
        (saved.find((entry) => entry.accountId === target.accountId)?.neverStarted && !target.neverStarted),
    )
  )
    throw new Error("Purge final target inventory changed.");
}
async function removeTargets(intent: PurgeIntent, saved: Targets, physical?: Physical) {
  for (const target of saved) {
    if (target.neverStarted) continue;
    if (!physical || !target.namespaceUid) return false;
    if (!(await physical(intent, { accountId: target.accountId, namespaceUid: target.namespaceUid }))) return false;
  }
  return true;
}

export function purgeReconciliation(
  context: ManagerContext,
  authority: PurgeAuthority,
  settle: (intent: PurgeIntent) => Promise<void>,
) {
  const rawIdentities = provisionIdentities(context);
  const erase = purgeErasure(context);
  const pending = new Map<string, Promise<unknown>>();

  async function own<T>(intent: PurgeIntent, run: () => Promise<T>) {
    const previous = pending.get(intent.accountId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    pending.set(intent.accountId, current);
    try {
      return await current;
    } finally {
      if (pending.get(intent.accountId) === current) pending.delete(intent.accountId);
    }
  }
  async function completed(intent: PurgeIntent) {
    const receipt = await authority.completion.read(intent);
    if (!receipt) return null;
    await settle(intent);
    // An older manager backup can restore rows after remote physical completion.
    await erase(intent);
    return { ...purgeOperation(intent), state: "succeeded" as const, completed_at: receipt.completedAt };
  }
  async function targets(intent: PurgeIntent, discover: Discover) {
    const history = await authority.history.listByCreateDigest(intent.createRequestDigest);
    const raw = await rawIdentities(intent.createRequestDigest);
    const namespaces = await discover(intent);
    const ids = new Set([
      intent.accountId,
      ...raw.map((row) => row.accountId),
      ...history.map((row) => row.identity.accountId),
    ]);
    for (const target of namespaces) ids.add(target.id);
    const result = [];
    for (const id of ids) {
      const record = history.find((row) => row.identity.accountId === id);
      const row = raw.find((row) => row.accountId === id);
      if (row && record && !isDeepStrictEqual(row, record.identity))
        throw new Error("Purge provision admission differs.");
      const namespaceUid = namespaces.find((target) => target.id === id)?.namespaceUid ?? null;
      result.push({
        accountId: id,
        namespaceUid,
        neverStarted: !namespaceUid && Boolean(record?.admission && !record.start),
      });
    }
    return PurgeTargets.parse(result.sort((left, right) => left.accountId.localeCompare(right.accountId)));
  }
  async function reconcile(intent: PurgeIntent, discover: Discover, physical?: Physical) {
    if (await completed(intent)) return;
    await settle(intent);
    const progress = await createPurgeProgress(authority.dependencies, "targets", PurgeTargets);
    const current = await targets(intent, discover);
    let retained = await progress.acknowledge(intent);
    if (!retained) {
      if (current.some((target) => !target.neverStarted && !target.namespaceUid)) return;
      retained = await progress.retain(intent, current);
    }
    requireObserved(current, retained.payload);
    if (!(await removeTargets(intent, retained.payload, physical))) return;
    for (const target of retained.payload) await authority.storage.clean(`accounts/${target.accountId}/`);
    const final = await targets(intent, discover);
    requireFinal(final, retained.payload);
    await erase(intent);
    await authority.completion.complete(intent);
  }
  return {
    async status(id: string) {
      await authority.refresh();
      const intent = authority.operation(id);
      if (!intent) return undefined;
      return own(intent, async () => (await completed(intent)) ?? purgeOperation(intent));
    },
    async reconcile(discover: Discover, physical?: Physical) {
      await authority.refresh();
      for (const intent of authority.intents()) {
        try {
          await own(intent, () => reconcile(intent, discover, physical));
        } catch (error) {
          // Missing authority, identity or provider evidence retains the irreversible intent as pending.
          console.error(
            JSON.stringify({
              event: "account_purge_retry",
              accountId: intent.accountId,
              operationId: intent.operationId,
              reason:
                error instanceof Error && error.name === "Error"
                  ? error.message
                  : "Purge authority or provider evidence is invalid.",
            }),
          );
        }
      }
    },
  };
}
