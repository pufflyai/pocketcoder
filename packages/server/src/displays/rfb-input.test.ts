import { expect, test } from "bun:test";
import { RfbInput } from "./rfb-input";

function connected(control: boolean) {
  const input = new RfbInput(control);
  expect(input.receive(Buffer.from("RFB 003.008\n"))).toHaveLength(1);
  expect(input.receive(new Uint8Array([1, 1]))).toHaveLength(2);
  return input;
}

test("viewers may request pixels but fragmented keyboard and pointer input is denied", () => {
  const input = connected(false);
  expect(input.receive(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 10, 0, 10]))).toHaveLength(1);
  expect(input.receive(new Uint8Array([4, 1, 0]))).toEqual([]);
  expect(() => input.receive(new Uint8Array([0, 0, 0, 0, 65]))).toThrow("control");
  expect(() => connected(false).receive(new Uint8Array([5, 1, 0, 1, 0, 2]))).toThrow("control");
});

test("controllers may send complete input, while clipboard and unknown extensions are rejected", () => {
  const input = connected(true);
  const key = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 65]);
  expect(input.receive(key.subarray(0, 4))).toEqual([]);
  expect(input.receive(key.subarray(4))).toEqual([key]);
  expect(input.receive(new Uint8Array([5, 1, 0, 1, 0, 2]))).toHaveLength(1);
  for (const type of [6, 150, 250, 255]) {
    expect(() => connected(true).receive(new Uint8Array([type, 0, 0, 0, 0, 0, 0, 0]))).toThrow();
  }
});

test("handshake and encoding counts stay bounded", () => {
  expect(() => new RfbInput(false).receive(Buffer.from("RFB 003.003\n"))).toThrow();
  expect(() => connected(false).receive(new Uint8Array(65_537))).toThrow();
  expect(() => connected(false).receive(new Uint8Array([2, 0, 255, 255]))).toThrow();
});
