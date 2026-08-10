import { describe, expect, test } from "bun:test";
import { serverOutput } from "./process-output";

describe("example server output", () => {
  test("keeps background server logs out of the interactive Pi terminal", () => {
    expect(serverOutput({ interactive: true, debug: false })).toEqual({
      stdout: "ignore",
      stderr: "ignore",
    });
  });

  test("preserves server logs for automation and explicit debugging", () => {
    expect(serverOutput({ interactive: false, debug: false })).toEqual({
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(serverOutput({ interactive: true, debug: true })).toEqual({
      stdout: "inherit",
      stderr: "inherit",
    });
  });
});
