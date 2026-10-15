import { type WorkloadTemplateSnapshot, WorkloadTemplateSnapshotSchema } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceDriver } from "../driver";
import type { WorkspaceRow, WorkspaceStore } from "../types";

// Admission calls this after creation and before registration. It does not
// advertise the complete profile; input/export qualification remains separate.
export async function prepareWaitingRuntime(
  deps: { store: WorkspaceStore; driver: WorkspaceDriver },
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
