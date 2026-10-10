import { expect, test } from "bun:test";
import { BrowserInput } from "./browser-input";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
test("browser input allows bounded typed actions and rejects raw CDP and view-only input", () => {
  const input = new BrowserInput(true);
  const action = { action: "click", x: 100, y: 200 };
  expect(JSON.parse(new TextDecoder().decode(input.receive(bytes(action))[0]))).toEqual(action);
  expect(() => new BrowserInput(false).receive(bytes(action))).toThrow();
  for (const forged of [
    { method: "Runtime.evaluate", params: { expression: "1" } },
    { action: "Runtime.evaluate" },
    { action: "navigate", url: "javascript:alert(1)" },
    { action: "navigate", url: "http://user:password@example.com" },
    { action: "click", x: 1280, y: 0 },
    { action: "key", key: "Enter", method: "Page.navigate" },
    { action: "text", text: "x".repeat(1025) },
  ])
    expect(() => input.receive(bytes(forged))).toThrow();
  expect(() => input.receive(new Uint8Array(4097))).toThrow();
});
