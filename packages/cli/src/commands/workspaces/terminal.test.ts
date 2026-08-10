import { describe, expect, test } from "bun:test";
import { TerminalDetachParser } from "./terminal";

describe("terminal detach input", () => {
  test("recognizes Ctrl-] followed by d across input chunks", () => {
    const parser = new TerminalDetachParser();
    expect(parser.push(Uint8Array.of(1, 0x1d))).toEqual({
      forward: [Uint8Array.of(1)],
      detached: false,
    });
    expect(parser.push(Uint8Array.of("d".charCodeAt(0), 2))).toEqual({
      forward: [],
      detached: true,
    });
  });

  test("forwards the escape byte when it is not followed by d", () => {
    const parser = new TerminalDetachParser();
    parser.push(Uint8Array.of(0x1d));
    expect(parser.push(Uint8Array.of("x".charCodeAt(0)))).toEqual({
      forward: [Uint8Array.of(0x1d, "x".charCodeAt(0))],
      detached: false,
    });
  });
});
