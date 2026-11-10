import { expect, test } from "bun:test";
import { normalizeMessages } from "./agent";

test("shows Onefin prose after AgentAPI wraps transcript records across terminal rows", () => {
  const content = String.raw`<ot>{"type":"text","text":"You're\u002
0connected\u0020to\u0020"}</ot>
<ot>{"type":"tool_start","name":"bash","args":{}}</ot>
<ot>{"type":"text_delta","text":"**Development\u0020AB**."}</ot>`;
  expect(normalizeMessages("machine", [{ role: "agent", content }])[0]?.parts).toEqual([
    { type: "text", text: "You're connected to **Development AB**." },
  ]);
  expect(normalizeMessages("machine", [{ role: "user", content }])[0]?.parts).toEqual([
    { type: "text", text: content },
  ]);
});

test("shows Onefin errors as text and keeps ordinary agent messages", () => {
  expect(
    normalizeMessages("machine", [
      { role: "agent", content: '<ot>{"type":"error","message":"Model unavailable"}</ot>' },
    ])[0]?.parts,
  ).toEqual([{ type: "text", text: "Model unavailable" }]);
  expect(normalizeMessages("machine", [{ role: "agent", content: "echo: hello" }])[0]?.parts).toEqual([
    { type: "text", text: "echo: hello" },
  ]);
});

test.each([
  "Use <ot> to begin a transcript record.",
  'Before <ot>{"type":"text","text":"inside"}</ot> after',
  "<ot>null</ot>",
  '<ot>{"example":"ordinary JSON"}</ot>',
])("keeps ordinary agent prose containing transcript syntax: %s", (content) => {
  expect(normalizeMessages("machine", [{ role: "agent", content }])[0]?.parts).toEqual([
    { type: "text", text: content },
  ]);
});
