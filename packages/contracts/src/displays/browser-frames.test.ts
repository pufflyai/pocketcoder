import { expect, test } from "bun:test";
import { PREVIEW_FRAME_BYTES } from "../previews/preview";
import { BROWSER_IMAGE_BYTES, BrowserFrames, browserFrameChunks } from "./browser-frames";

test("a detailed browser image crosses bounded transport chunks without losing bytes", () => {
  const image = new Uint8Array(303977).map((_, index) => index % 251);
  const chunks = [...browserFrameChunks(image)];
  expect(chunks.length).toBeGreaterThan(1);
  const frames = new BrowserFrames();
  let result: Uint8Array | undefined;
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(PREVIEW_FRAME_BYTES);
    result = frames.receive(chunk);
  }
  expect(result).toEqual(image);
});

test("browser image assembly rejects oversized images, gaps and overlapping frames", () => {
  expect(() => [...browserFrameChunks(new Uint8Array(BROWSER_IMAGE_BYTES + 1))]).toThrow();
  const [first, second] = [...browserFrameChunks(new Uint8Array(100000))];
  if (!first || !second) throw new Error("Missing frame fixture chunks.");
  expect(() => new BrowserFrames().receive(second)).toThrow();
  const frames = new BrowserFrames();
  frames.receive(first);
  expect(() => frames.receive(first)).toThrow();
  const forged = first.slice();
  new DataView(forged.buffer).setUint32(0, BROWSER_IMAGE_BYTES + 1);
  expect(() => new BrowserFrames().receive(forged)).toThrow();
});
