import { type ExecutionRecord, ExecutionRecordSchema, type WorkspaceRequest } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

const path = (workspaceId: string) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/requests`;

export class WorkspaceRequestsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  submit(workspaceId: string, input: WorkspaceRequest, options: RequestOptions = {}) {
    return this.transport.request(path(workspaceId), ExecutionRecordSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  get(workspaceId: string, requestId: string, conversationId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `${path(workspaceId)}/${encodeURIComponent(requestId)}?${queryString({ conversationId })}`,
      ExecutionRecordSchema,
      options,
    );
  }
  list(
    workspaceId: string,
    query: { conversationId: string; cursor?: string; limit?: number },
    options: RequestOptions = {},
  ) {
    return this.transport.request(
      `${path(workspaceId)}?${queryString(query)}`,
      z.object({ items: z.array(ExecutionRecordSchema), next_cursor: z.uuid().nullable() }),
      options,
    );
  }
  cancel(record: ExecutionRecord, cancelId: string, options: RequestOptions = {}) {
    const execution = record.acceptance.execution;
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(execution.workspaceId)}/executions/${encodeURIComponent(execution.requestId)}/cancel`,
      ExecutionRecordSchema,
      {
        ...options,
        method: "POST",
        body: JSON.stringify({ execution, cancelId, scope: "operation" }),
      },
    );
  }
}
