import { ManagerError } from "../accounts/errors";
import type { ManagerContext } from "../database/context";
import { type Release, releaseVersion, requireRollback, requireUpgrade } from "./releases";

type Operation = ManagerContext["tables"]["operations"]["$inferSelect"];
export function requireReplay(prior: Operation, version: string) {
  if (prior.kind !== "upgrade" || prior.upgrade?.requestedVersion !== version)
    throw new ManagerError(409, "idempotency_conflict");
}
export function resolveUpgrade(
  account: { state: string; plan: { offNodeBackups?: boolean; controllerImage: string } },
  pending: unknown,
  version: string,
  releases: Release[],
) {
  if (pending) throw new ManagerError(409, "account_operation_pending");
  if (account.state !== "ready") throw new ManagerError(409, "account_state_conflict");
  if (!account.plan.offNodeBackups) throw new ManagerError(409, "off_node_not_configured");
  const source = releases.find((release) => release.controllerImage === account.plan.controllerImage);
  if (!source) throw new ManagerError(409, "source_release_not_tested");
  const target = releaseVersion(releases, version);
  requireUpgrade(source, target);
  return { source, target };
}
export function requireRecoveryOperation(operation: Operation | undefined, accountId: string) {
  if (operation?.accountId !== accountId || operation.kind !== "upgrade" || !operation.upgrade)
    throw new ManagerError(404, "upgrade_not_found");
  return { ...operation, upgrade: operation.upgrade };
}
export function resolveRecovery(
  operation: ReturnType<typeof requireRecoveryOperation>,
  mode: "rollback" | "forward_fix" | "restore",
  version: string | undefined,
  releases: Release[],
) {
  if (operation.state === "succeeded" || !operation.errorCode || !["install", "verify"].includes(operation.phase))
    throw new ManagerError(409, "upgrade_recovery_conflict");
  if (mode === "rollback") requireRollback(operation.upgrade);
  if (mode === "forward_fix") {
    const target = releaseVersion(releases, version ?? "");
    requireUpgrade(operation.upgrade.target, target);
    return target;
  }
  return operation.upgrade.source;
}
