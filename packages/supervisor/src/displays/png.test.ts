import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng } from "./png";

test("desktop RGB pixels become a bounded PNG with exact rows", () => {
  const bytes = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 255, 0]));
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBe(2);
  expect(bytes.readUInt32BE(20)).toBe(1);
  const length = bytes.readUInt32BE(33);
  expect(inflateSync(bytes.subarray(41, 41 + length))).toEqual(Buffer.from([0, 255, 0, 0, 0, 255, 0]));
  expect(() => encodePng(1921, 1, new Uint8Array())).toThrow("dimensions");
});
