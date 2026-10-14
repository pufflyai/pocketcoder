import type { AdmissionReason } from "@pstdio/pocketcoder-contracts";
import type { ActiveCounts, WorkspaceRow } from "../types";
import type { AdmissionLimits, SchedulerContext } from "./scheduler-base";

export function capacityReason(row: WorkspaceRow, counts: ActiveCounts, limits: AdmissionLimits) {
  if (counts.global >= limits.globalActiveWorkspaces) return "admission_global_capacity" as const;
  if ((counts.byPrincipal[row.principalId] ?? 0) >= limits.perPrincipalActiveWorkspaces)
    return "admission_principal_capacity" as const;
  const templateLimit = limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
  if ((counts.byTemplate[row.templateName] ?? 0) >= templateLimit) return "admission_template_capacity" as const;
  return null;
}

export async function recordCapacityReasons(context: SchedulerContext, counts: ActiveCounts) {
  // External actor/policy denials describe only the checked workspace. Controller
  // counters can explain all queued rows without guessing an external identity.
  const queued = (await context.deps.store.listNonterminal()).filter((row) => row.state === "queued");
  let changed = false;
  for (const row of queued) {
    const reason = capacityReason(row, counts, context.deps.limits);
    const local = ["admission_global_capacity", "admission_principal_capacity", "admission_template_capacity"];
    if (row.reasonCode !== reason && (reason || local.includes(row.reasonCode ?? ""))) {
      await context.deps.store.setQueuedAdmissionReason(row.id, reason, context.now());
      changed = true;
    }
  }
  return changed;
}

export function recordAdmissionReason(context: SchedulerContext, id: string, reason: AdmissionReason) {
  return context.deps.store.setQueuedAdmissionReason(id, reason, context.now());
}
