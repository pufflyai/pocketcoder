import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PocketCoderClient } from "../../client";

const sessionId = randomUUID();
const session = (revision: number) => ({
  sessionId,
  profileId: randomUUID(),
  profileRevision: 1,
  revision,
  state: "provisioning",
  reasonCode: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const frame = (sequence: number) =>
  `id: ${sessionId}:${sequence}\nevent: session.updated\ndata: ${JSON.stringify({
    eventId: randomUUID(),
    cursor: `${sessionId}:${sequence}`,
    sessionId,
    requestId: null,
    sequence,
    revision: sequence,
    occurredAt: null,
    recordedAt: new Date().toISOString(),
    kind: "session.updated",
    data: session(sequence),
  })}\n\n`;

test("session events resume after the last cursor and surface a mid-stream error", async () => {
  const requests: Request[] = [];
  const bodies = [
    `${frame(1)}event: keepalive\ndata: {}\n\n`,
    frame(2),
    `event: error\ndata: {"code":"events.cursor_expired"}\n\n`,
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input.toString(), init));
    return new Response(bodies.shift() ?? "", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const client = new PocketCoderClient({ baseUrl: "http://pocketcoder.test", apiKey: "pkt_example" }, fetchImpl);
  const seen: number[] = [];
  const error = await (async () => {
    for await (const event of client.sessions.events(sessionId)) seen.push(event.sequence);
  })().catch((caught: unknown) => caught);
  expect(seen).toEqual([1, 2]);
  expect(error).toMatchObject({ code: "events.cursor_expired" });
  expect(requests.map((request) => new URL(request.url).searchParams.get("after"))).toEqual([
    null,
    `${sessionId}:1`,
    `${sessionId}:2`,
  ]);
  expect(requests[1]?.headers.get("last-event-id")).toBe(`${sessionId}:1`);
});
