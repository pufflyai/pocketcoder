import { expect, test } from "bun:test";
import { FramePublisher } from "./frame-publisher";

test("the screencast rate limit publishes the latest frame after rapid edits", async () => {
  const sent: { value: number | undefined; at: number }[] = [];
  let delivered!: () => void;
  const first = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const publisher = new FramePublisher((bytes) => {
    sent.push({ value: bytes[0], at: performance.now() });
    delivered();
  });
  try {
    publisher.receive(new Uint8Array([1]));
    await first;
    publisher.receive(new Uint8Array([2]));
    publisher.receive(new Uint8Array([3]));
    await Bun.sleep(80);
    expect(sent.map((frame) => frame.value)).toEqual([1, 3]);
    expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(1000 / 15);
  } finally {
    publisher.close();
  }
});
