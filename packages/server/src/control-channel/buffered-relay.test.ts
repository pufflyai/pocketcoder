import { expect, test } from "bun:test";
import type { ProxyResponse } from "@pstdio/pocketcoder-contracts";
import { bufferedRelay, MAX_INFLIGHT_RELAY } from "./buffered-relay";
import type { LiveConnection } from "./hub-connection";

// The connection is the hub's in-memory record of one workspace; the relay only reads its slots.
function liveConnection() {
  return { registered: true, inflight: new Map(), streams: new Map() } as unknown as LiveConnection;
}

const request = { method: "POST", path: "/executions/cancel", headers: {}, body: "", deadline_ms: 50 } as never;

test("cancels from several conversations in one workspace are all sent, even with every ordinary slot taken", async () => {
  const conn = liveConnection();
  const sent: string[] = [];
  const send = (_conn: LiveConnection, _type: "proxy_request", payload: { request_id: string }) => {
    sent.push(payload.request_id);
  };
  const ordinary = Array.from({ length: MAX_INFLIGHT_RELAY }, () => bufferedRelay(conn, request, send));
  expect((await bufferedRelay(conn, request, send)).error_code).toBe("deadline");

  const cancels = [bufferedRelay(conn, request, send, true), bufferedRelay(conn, request, send, true)];
  expect(sent).toHaveLength(MAX_INFLIGHT_RELAY + 2);

  const answered: ProxyResponse[] = await Promise.all([...ordinary, ...cancels]);
  expect(answered.every((response) => response.error_code === "deadline")).toBe(true);
});
