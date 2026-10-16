import {
  ApiError,
  EXECUTION_DISPATCH_MIN_PROTOCOL_VERSION,
  type ExecutionRecord,
  executionSettled,
} from "@pstdio/pocketcoder-contracts";
import type { ExecutionTransport, Store, WorkspaceDriver, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { InputStorage } from "../attachments/input-storage";
import { prepareExecutionInputs } from "./execution-inputs";
import type { Hub } from "./hub";

export function processTransport(deps: {
  store: Store;
  hub: Hub;
  inputs?: InputStorage;
  driver: Pick<WorkspaceDriver, "publishInputs">;
}): ExecutionTransport {
  const connection = (workspace: WorkspaceRow) => {
    const live = deps.hub.get(workspace.id);
    if (
      !live?.registered ||
      live.epoch !== workspace.connectionEpoch ||
      live.protocolVersion < EXECUTION_DISPATCH_MIN_PROTOCOL_VERSION
    )
      throw new ApiError("workspace.disconnected", "Runtime connection changed.");
    return live;
  };
  return {
    connected: (workspace) =>
      deps.hub.isConnected(workspace.id) && workspace.runtimeRegistration?.profile === "finite-process",
    async accept(record, workspace) {
      const { acceptance } = record;
      const inputDirectory = await prepareExecutionInputs(deps, record, workspace);
      // Preparation can wait on storage. Recheck ordered cancel and deadline before sending.
      const current = await deps.store.executions.claim(acceptance.execution, new Date());
      if (!current || executionSettled(current.record)) return;
      if (current.record.cancel) {
        await sendCancel(current.record, workspace);
        return;
      }
      deps.hub.send(connection(workspace), "process_start", {
        execution: acceptance.execution,
        fingerprint: acceptance.fingerprint,
        operation: acceptance.operation,
        input: acceptance.input,
        ...(inputDirectory ? { inputDirectory } : {}),
      });
    },
    async lookup(record, workspace) {
      deps.hub.send(connection(workspace), "process_lookup", { execution: record.acceptance.execution });
      return undefined;
    },
    cancel: sendCancel,
    async acknowledge(record, workspace) {
      deps.hub.send(connection(workspace), "process_ack", { execution: record.acceptance.execution });
      await deps.store.executions.acknowledge(record.acceptance.execution, record.acceptance.fingerprint, new Date());
    },
  };
  async function sendCancel(record: ExecutionRecord, workspace: WorkspaceRow) {
    if (!record.cancel) throw new Error("Cancel intent missing");
    const template = workspace.runtimeRegistration?.template;
    if (!template) throw new Error("Accepted execution template missing");
    const graceMs = Math.max(
      0,
      template.manifest.spec.limits.finalizationSeconds * 1000 - (Date.now() - Date.parse(record.cancel.requestedAt)),
    );
    deps.hub.send(connection(workspace), "process_cancel", {
      execution: record.acceptance.execution,
      cancelId: record.cancel.cancelId,
      signal: graceMs === 0 ? "SIGKILL" : "SIGTERM",
      graceMs,
    });
  }
}
