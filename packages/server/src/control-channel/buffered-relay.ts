import { randomUUID } from "node:crypto";
import type { ProxyRequest, ProxyResponse, ServerFrame } from "@pstdio/pocketcoder-contracts";
import type { LiveConnection } from "./hub-connection";

export const MAX_INFLIGHT_RELAY = 16;
export const MAX_CONTROL_RELAY = 16;

export function bufferedRelay(
  conn: LiveConnection | undefined,
  request: Omit<ProxyRequest, "request_id">,
  send: (
    conn: LiveConnection,
    type: "proxy_request",
    payload: Extract<ServerFrame, { type: "proxy_request" }>["payload"],
  ) => void,
  control = false,
): Promise<ProxyResponse> {
  const requestId = randomUUID();
  if (!conn?.registered) return Promise.resolve({ request_id: requestId, headers: {}, error_code: "unreachable" });
  // Cancellation and terminal receipts have their own bounded budget, so a full ordinary budget never delays
  // them and each conversation of a workspace can cancel its request at the same time.
  const controls = [...conn.inflight.values()].filter((pending) => pending.control).length;
  const full = control
    ? controls >= MAX_CONTROL_RELAY
    : conn.inflight.size - controls + conn.streams.size >= MAX_INFLIGHT_RELAY;
  if (full) return Promise.resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.inflight.delete(requestId);
      resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
    }, request.deadline_ms);
    conn.inflight.set(requestId, { resolve, timer, control });
    send(conn, "proxy_request", { ...request, request_id: requestId });
  });
}
