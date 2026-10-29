import { randomUUID } from "node:crypto";
import type { ProxyRequest, ProxyResponse, ServerFrame } from "@pstdio/pocketcoder-contracts";
import type { LiveConnection } from "./hub-connection";

export const MAX_INFLIGHT_RELAY = 16;

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
  // One bounded slot is reserved for cancellation and its terminal receipt.
  const limit = MAX_INFLIGHT_RELAY + Number(control);
  if (
    conn.inflight.size + conn.streams.size >= limit ||
    (control && [...conn.inflight.values()].some((pending) => pending.control))
  )
    return Promise.resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.inflight.delete(requestId);
      resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
    }, request.deadline_ms);
    conn.inflight.set(requestId, { resolve, timer, control });
    send(conn, "proxy_request", { ...request, request_id: requestId });
  });
}
