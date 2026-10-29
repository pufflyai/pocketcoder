import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { StructuredLogger } from "../../observability/observability";
import { ensureManagedKey, type KeyChange } from "./managed-keys";
import {
  admissionMap,
  type ManagedKey,
  type ManagedPrincipal,
  managedPrincipalId,
  type PrincipalFile,
} from "./principal-file";
import { desiredGrants, type PrincipalChange, planPrincipals } from "./principal-plan";
import { secretTargetStore } from "./secret-targets";

interface ReconcileDeps {
  store: Store;
  pepper: string;
  file: PrincipalFile;
  dryRun: boolean;
  logger: StructuredLogger;
  now?: Date;
}

async function applyPrincipal(store: Store, change: PrincipalChange, declared: ManagedPrincipal | undefined) {
  if (declared && (change.action === "create" || change.action === "update")) {
    await store.applyConfiguredPrincipal({
      id: change.id,
      name: change.name,
      ...desiredGrants(declared),
      disabled: false,
    });
  }
  const removed = change.action === "disable" ? await store.getPrincipal(change.id) : null;
  if (removed) {
    const { id, name, scopes, templateNames } = removed;
    await store.applyConfiguredPrincipal({ id, name, scopes, templateNames, disabled: true });
  }
}

async function reconcileKey(deps: ReconcileDeps, declared: ManagedPrincipal, key: ManagedKey, now: Date) {
  const target = secretTargetStore(key.target);
  const principal = await deps.store.getPrincipal(managedPrincipalId(declared.name));
  // A dry run plans keys for principals it has not created yet.
  const change: KeyChange = principal
    ? await ensureManagedKey({ ...deps, principal, config: declared, target, now })
    : { action: "issue", reason: "missing", keyId: null, retired: [] };
  return { name: declared.name, target: target.describe(), ...change };
}

async function reconcileAdmissionMap({ file, dryRun }: ReconcileDeps) {
  if (!file.admission_map) return null;
  const target = secretTargetStore(file.admission_map);
  const content = `${JSON.stringify(admissionMap(file), null, 2)}\n`;
  if ((await target.read())?.trim() === content.trim()) return "unchanged" as const;
  if (!dryRun) await target.write(content);
  return "write" as const;
}

// Applies the principal file. The same call runs at startup and on each renewal tick,
// so a second run with an unchanged file and healthy keys changes nothing.
export async function reconcileManagedPrincipals(deps: ReconcileDeps) {
  const { store, file, dryRun, logger } = deps;
  const now = deps.now ?? new Date();
  const principals = planPrincipals(file, await store.listPrincipals());
  for (const change of principals.filter((change) => change.action !== "unchanged")) {
    logger.info("principals.change", { ...change, changes: change.changes.join(","), dry_run: dryRun });
  }
  const conflicts = principals.filter((change) => change.action === "conflict").map((change) => change.name);
  // A dry run reports conflicts in its plan; applying stops before any change.
  if (conflicts.length && !dryRun) {
    throw new Error(`principal file names principals it does not manage: ${conflicts.join(", ")}`);
  }
  const declared = new Map(file.principals.map((principal) => [principal.name, principal]));
  if (!dryRun) for (const change of principals) await applyPrincipal(store, change, declared.get(change.name));

  const keys = [];
  for (const principal of file.principals) {
    if (!principal.key) continue;
    const change = await reconcileKey(deps, principal, principal.key, now);
    keys.push(change);
    if (change.action === "keep" && !change.retired.length) continue;
    logger.info("principals.key", {
      name: change.name,
      action: change.action,
      reason: change.reason,
      target: change.target,
      key_id: change.keyId,
      retired: change.retired.join(","),
      dry_run: dryRun,
    });
  }
  const admission = await reconcileAdmissionMap(deps);
  if (admission === "write") logger.info("principals.admission_map", { action: admission, dry_run: dryRun });
  return { principals, keys, admissionMap: admission };
}
