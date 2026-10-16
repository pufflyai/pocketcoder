import {
  ApiError,
  canonicalJson,
  type ExecutionRecord,
  executionSettled,
  ProducerObservationSchema,
} from "@pstdio/pocketcoder-contracts";
import type { ExecutionTransport, Store, WorkspaceDriver, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { InputStorage } from "../attachments/input-storage";
import { prepareExecutionInputs } from "../control-channel/execution-inputs";
import type { Hub } from "../control-channel/hub";

// Capable service adapters use fixed, template-declared endpoints. Plain AgentAPI
// interruption remains workspace-scoped and is never used for operation cancellation.
export function conversationTransport(deps: {
  store: Store;
  hub: Hub;
  inputs?: InputStorage;
  driver: Pick<WorkspaceDriver, "publishInputs">;
}): ExecutionTransport {
  async function call(
    record: ExecutionRecord,
    workspace: WorkspaceRow,
    action: "accept" | "lookup" | "cancel" | "ack",
    body: unknown,
    control = false,
  ) {
    const spec = workspace.runtimeRegistration?.template?.manifest.spec;
    const operation = spec?.operations[record.acceptance.operation];
    const adapter = operation && spec?.adapters[operation.adapter];
    const service = adapter?.service;
    if (adapter?.protocol !== "pocketcoder.execution/v1" || !service)
      throw new ApiError("operation.conflict", "No installed execution service protocol.");
    const path = `/executions/${action}`;
    const route = spec?.services[service]?.routes.find(
      (r) => r.method === "POST" && r.path === path && r.responseMode === "buffered",
    );
    if (!route) throw new ApiError("relay.route_not_allowed", "Execution endpoint is not declared.");
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > route.maxRequestBytes)
      throw new ApiError("relay.body_too_large", "Execution envelope exceeds the route limit.");
    const method = control ? "relayExecutionCancel" : "relay";
    const reply = await deps.hub[method](workspace.id, {
      service,
      method: "POST",
      path,
      query: {},
      headers: { "content-type": "application/json" },
      body_b64: Buffer.from(payload).toString("base64"),
      deadline_ms: Math.min(route.deadlineSeconds * 1000, Math.max(1, workspace.deadlineAt.getTime() - Date.now())),
    });
    if (reply.error_code || !reply.status || reply.status >= 300)
      throw new ApiError("relay.upstream_error", "Execution response is unsettled; reconcile the same producer ID.");
    const bytes = Buffer.from(reply.body_b64 ?? "", "base64");
    if (bytes.byteLength > route.maxResponseBytes)
      throw new ApiError("relay.body_too_large", "Execution response exceeds the route limit.");
    return bytes;
  }
  async function observe(record: ExecutionRecord, workspace: WorkspaceRow, bytes: Buffer, control = false) {
    const fact = ProducerObservationSchema.parse(JSON.parse(bytes.toString()));
    if (canonicalJson(fact.execution) !== canonicalJson(record.acceptance.execution))
      throw new ApiError("operation.conflict", "Producer observation target mismatch.");
    if (fact.phase === "absent") return "absent" as const;
    if (fact.fingerprint !== record.acceptance.fingerprint)
      throw new ApiError("operation.conflict", "Producer fingerprint conflict.");
    if (fact.phase === "accepted") return;
    const recorded = await deps.store.executions.observe(
      fact.execution,
      fact.fingerprint,
      fact.phase,
      workspace.connectionEpoch,
      new Date(),
      fact.outcome,
    );
    if (recorded && ["terminal", "canceled"].includes(fact.phase)) {
      await call(record, workspace, "ack", { execution: fact.execution, fingerprint: fact.fingerprint }, control);
      await deps.store.executions.acknowledge(fact.execution, fact.fingerprint, new Date());
    }
  }
  return {
    connected: (workspace) => deps.hub.isConnected(workspace.id),
    async accept(record, workspace) {
      const inputDirectory = await prepareExecutionInputs(deps, record, workspace);
      const latest = await deps.store.executions.claim(record.acceptance.execution, new Date());
      if (!latest || executionSettled(latest.record)) return;
      if (latest.record.cancel) {
        await this.cancel(latest.record, workspace);
        return;
      }
      const reply = await call(record, workspace, "accept", {
        acceptance: record.acceptance,
        conversationIdentity: record.conversationIdentity,
        ...(inputDirectory ? { inputDirectory } : {}),
      });
      if ((await observe(record, workspace, reply)) === "absent")
        throw new ApiError("relay.upstream_error", "Producer did not accept the operation.");
    },
    async lookup(record, workspace) {
      return observe(
        record,
        workspace,
        await call(record, workspace, "lookup", { execution: record.acceptance.execution }),
      );
    },
    async acknowledge(record, workspace) {
      await call(
        record,
        workspace,
        "ack",
        {
          execution: record.acceptance.execution,
          fingerprint: record.acceptance.fingerprint,
        },
        Boolean(record.cancel),
      );
      await deps.store.executions.acknowledge(record.acceptance.execution, record.acceptance.fingerprint, new Date());
    },
    async cancel(record, workspace) {
      if (!record.cancel) throw new Error("Cancel intent missing");
      await observe(
        record,
        workspace,
        await call(
          record,
          workspace,
          "cancel",
          {
            execution: record.acceptance.execution,
            cancelId: record.cancel.cancelId,
            fingerprint: record.acceptance.fingerprint,
            scope: "operation",
          },
          true,
        ),
        true,
      );
    },
  };
}

export function executionTransport(process: ExecutionTransport, conversation: ExecutionTransport): ExecutionTransport {
  const owner = (record: ExecutionRecord) => (record.acceptance.execution.owner === "process" ? process : conversation);
  return {
    connected: (workspace) => process.connected(workspace) || conversation.connected(workspace),
    accept: (r, w) => owner(r).accept(r, w),
    lookup: (r, w) => owner(r).lookup(r, w),
    cancel: (r, w) => owner(r).cancel(r, w),
    acknowledge: (r, w) => owner(r).acknowledge(r, w),
  };
}
