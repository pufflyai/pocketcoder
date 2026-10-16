import { ApiError, type ExecutionRecord } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceDriver, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { InputStorage } from "../attachments/input-storage";

export async function prepareExecutionInputs(
  deps: { inputs?: InputStorage; driver: Pick<WorkspaceDriver, "publishInputs"> },
  record: ExecutionRecord,
  workspace: WorkspaceRow,
) {
  const { acceptance } = record;
  if (!acceptance.inputs.objects.length) return undefined;
  if (!deps.inputs || !deps.driver.publishInputs || !workspace.providerRef)
    throw new ApiError("operation.conflict", "Immutable input publication is unavailable.");
  const projection = await deps.inputs.freeze(
    acceptance.execution.requestId,
    workspace.id,
    acceptance.execution.incarnationId,
    acceptance.inputs.objects.map((o) => o.fileId),
  );
  const published = await deps.driver.publishInputs(
    { kind: workspace.providerKind ?? "", id: "", ...workspace.providerRef },
    projection,
  );
  return published.directory;
}
