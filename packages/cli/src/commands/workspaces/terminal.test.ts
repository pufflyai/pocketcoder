import { describe, expect, test } from "bun:test";
import { TerminalDetachParser, terminalPreflightIssue } from "./terminal";

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

describe("terminal preflight", () => {
  test("treats the upgrade-required response as a usable terminal", () => {
    const body = { error: { code: "validation.invalid", message: "WebSocket upgrade required." } };

    expect(terminalPreflightIssue(400, body)).toBeNull();
  });

  test("treats a 426 upgrade-required response as a usable terminal", () => {
    expect(terminalPreflightIssue(426, null)).toBeNull();
  });

  test("returns the server message when the template declares no terminal", () => {
    const body = { error: { code: "terminal.not_declared", message: "This workspace template has no terminal." } };

    expect(terminalPreflightIssue(409, body)).toBe("This workspace template has no terminal.");
  });

  test("falls back to the status when the body carries no message", () => {
    expect(terminalPreflightIssue(502, null)).toBe("terminal request failed with status 502");
  });
});
