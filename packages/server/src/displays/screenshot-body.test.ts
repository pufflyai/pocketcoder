import { expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import { validatePng } from "./screenshot-body";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
function image(data: Buffer) {
  const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from("IDAT"), data, Buffer.alloc(4)]);
  chunk.writeUInt32BE(data.length);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(-12)]);
}

test("PNG validation rejects forged image format, bad compression and oversized decoded data", () => {
  expect(() => validatePng(png)).not.toThrow();
  const format = Buffer.from(png);
  format[24] = 0;
  format.writeUInt32BE(crc32(format.subarray(12, 29)), 29);
  expect(() => validatePng(format)).toThrow("PNG");
  expect(() => validatePng(image(Buffer.alloc(12)))).toThrow("pixel");
  expect(() => validatePng(image(deflateSync(Buffer.alloc(1024))))).toThrow("pixel");
  expect(() => validatePng(image(deflateSync(Buffer.alloc(3))))).toThrow("pixel");
  expect(() => validatePng(image(deflateSync(Buffer.from([5, 255, 0, 0]))))).toThrow("filter");
});
