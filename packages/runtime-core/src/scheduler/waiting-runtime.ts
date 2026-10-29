import {
  parseWorkloadTemplate,
  type WorkloadLimits,
  type WorkloadTemplateSnapshot,
  WorkloadTemplateSnapshotSchema,
  workloadAdmission,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceDriver } from "../driver";
import type { WorkspaceRow, WorkspaceStore } from "../types";

// Admission calls this after creation and before registration. It does not
// advertise the complete profile; input/export qualification remains separate.
export async function prepareWaitingRuntime(
  deps: { store: WorkspaceStore; driver: WorkspaceDriver; workloadLimits?: WorkloadLimits },
  workspace: WorkspaceRow,
  input: WorkloadTemplateSnapshot,
) {
  const template = WorkloadTemplateSnapshotSchema.parse(input);
  if (workspace.templateDigest !== template.digest || !workspace.providerRef)
    throw new Error("Waiting runtime template or provider mismatch");
  const ref = { kind: workspace.providerKind ?? "", id: "", ...workspace.providerRef };
  const observed = await deps.driver.inspect(ref);
  if (!observed.exists || !observed.running || !observed.containerIdentity)
    throw new Error("A live driver-observed container identity is required");
  const incarnationId = observed.containerIdentity;
  const producer = observed.workload ?? null;
  if (
    producer &&
    (producer.workspaceId !== workspace.id ||
      producer.incarnationId !== incarnationId ||
      producer.templateDigest !== template.digest)
  )
    throw new Error("Installed producer identity mismatch");
  if (workspace.templateSnapshot.manifest) {
    if (!deps.workloadLimits) throw new Error("Deployment workload limits are not configured.");
    const admission = workloadAdmission(parseWorkloadTemplate(template.manifest), {
      workspaceId: workspace.id,
      incarnationId,
      profiles: ["service"],
      storageProfiles: ["controller-readonly/v1"],
      ceilings: deps.workloadLimits,
      now: new Date().toISOString(),
      expiresAt: workspace.deadlineAt.toISOString(),
      installed: producer ?? undefined,
    });
    if (!admission.supported) throw new Error(`Installed workload is not qualified: ${admission.reasons.join("; ")}`);
  }
  const bound = await deps.store.bindWorkspaceRuntime(
    workspace.id,
    {
      incarnationId,
      containerIdentity: incarnationId,
      profile: template.manifest.spec.profile,
      producer,
      template,
    },
    workspace.providerRef,
  );
  if (!bound) throw new Error("Runtime registration changed");
  return incarnationId;
}
