import { defineConnection, type ExtensionConnectionsApi } from "@pstdio/sdk/extensions";

export const connection = defineConnection({
  id: "pocketcoder",
  label: "PocketCoder",
  transport: "http",
  auth: { type: "bearer" },
  allowedMethods: ["GET", "POST"],
  allowedPathPrefixes: ["/v1/templates", "/v1/workspaces"],
  check: { method: "GET", path: "/v1/templates?limit=1" },
});

export type ConnectionContext = { connections: ExtensionConnectionsApi };
export class PocketCoderRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`PocketCoder HTTP ${status}: ${message}`);
  }
}
export async function request<T>(ctx: ConnectionContext, input: Parameters<ExtensionConnectionsApi["request"]>[1]) {
  const response = await ctx.connections.request<T>(connection.id, input);
  if (response.status < 200 || response.status >= 300) {
    const error = response.body as { error?: { message?: string } } | null;
    throw new PocketCoderRequestError(response.status, error?.error?.message ?? "Request failed.");
  }
  return response.body;
}

export interface RemoteWorkspace {
  id: string;
  external_id: string;
  state:
    | "queued"
    | "provisioning"
    | "connected"
    | "ready"
    | "preserving"
    | "terminating"
    | "succeeded"
    | "failed"
    | "canceled"
    | "expired"
    | "preserved";
  agent_state: string;
  change_cursor: number;
  reason_code: string | null;
  failure: { log_tail: string } | null;
}

export const workspacePath = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;
export const isTerminal = (workspace: RemoteWorkspace) =>
  ["succeeded", "failed", "canceled", "expired", "preserved"].includes(workspace.state);
