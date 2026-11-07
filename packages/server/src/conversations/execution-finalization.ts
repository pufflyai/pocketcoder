import { ApiError, type ExecutionRecord, executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceDriver, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

// The acknowledged producer has stopped reading this operation's inputs. Only
// no-export service operations are qualified; other publication barriers stay closed.
export async function finalizeServiceExecution(
  deps: { store: Store; driver: Pick<WorkspaceDriver, "releaseInputProjection"> },
  record: ExecutionRecord,
  workspace: WorkspaceRow,
) {
  const operation = workspace.runtimeRegistration?.template?.manifest.spec.operations[record.acceptance.operation];
  if (!operation) throw new ApiError("operation.conflict", "Output operation is unavailable.");
  await deps.store.exports.seal(record.acceptance.execution, new Date());
  if (record.acceptance.inputs.objects.length) {
    if (!deps.driver.releaseInputProjection || !workspace.providerRef)
      throw new ApiError("operation.conflict", "Input projection cleanup is unavailable.");
    await deps.driver.releaseInputProjection(
      { kind: workspace.providerKind ?? "", id: "", ...workspace.providerRef },
      executionInputManifestId(record.acceptance),
    );
  }
  await deps.store.exports.completeCleanup(record.acceptance.execution);
  await deps.store.executions.finalize(record.acceptance.execution, new Date());
}
