import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PREVIEW_FRAME_BYTES, PREVIEW_QUEUE_BYTES, type PreviewSocketMessage } from "./preview";
import { PreviewQueueBudget, PreviewSocketFlow } from "./socket-flow";

test("real socket flow waits for acknowledgement and keeps aggregate queued bytes bounded", () => {
  const frames: PreviewSocketMessage[] = [];
  let closed = false;
  const id = randomUUID();
  const flow = new PreviewSocketFlow(
    id,
    {
      send() {},
      close() {
        closed = true;
      },
      bufferedAmount: () => 0,
    },
    (frame) => frames.push(frame),
    new PreviewQueueBudget(),
    () => {},
  );
  flow.output("first");
  flow.output("second");
  expect(frames.map((frame) => frame.op)).toEqual(["data"]);
  flow.receive({ op: "ack", request_id: id, seq: 0 });
  expect(frames.map((frame) => frame.op)).toEqual(["data", "data"]);
  for (let i = 0; i <= PREVIEW_QUEUE_BYTES / PREVIEW_FRAME_BYTES; i++) flow.output(new Uint8Array(PREVIEW_FRAME_BYTES));
  expect(closed).toBe(true);
  expect(frames.at(-1)?.op).toBe("close");
});

test("rejects oversized frames and repeated receive sequences", () => {
  let closed = 0;
  const id = randomUUID();
  const flow = new PreviewSocketFlow(
    id,
    {
      send() {},
      close() {
        closed++;
      },
      bufferedAmount: () => 0,
    },
    () => {},
    new PreviewQueueBudget(),
    () => {},
  );
  const message = {
    op: "data" as const,
    request_id: id,
    seq: 0,
    binary: false,
    content_b64: Buffer.from("ok").toString("base64"),
  };
  flow.receive(message);
  flow.receive(message);
  expect(closed).toBe(1);
  const other = new PreviewSocketFlow(
    randomUUID(),
    {
      send() {},
      close() {
        closed++;
      },
      bufferedAmount: () => 0,
    },
    () => {},
    new PreviewQueueBudget(),
    () => {},
  );
  other.output(new Uint8Array(PREVIEW_FRAME_BYTES + 1));
  expect(closed).toBe(2);
});

test("empty messages consume the shared queue budget", () => {
  let closed = false;
  const flow = new PreviewSocketFlow(
    randomUUID(),
    {
      send() {},
      close() {
        closed = true;
      },
      bufferedAmount: () => 0,
    },
    () => {},
    new PreviewQueueBudget(),
    () => {},
  );
  for (let i = 0; i < 40_000; i++) flow.output("");
  expect(closed).toBe(true);
});
