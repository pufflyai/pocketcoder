import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { emitRemoteResponse } from "./response-stream";

test("replaces Pi partial text for every full AgentAPI snapshot", async () => {
  const output = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "pocketcoder-agentapi",
    model: "remote-agent",
    stopReason: "pending",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  const observed: Array<{ type: string; text: string; delta?: string }> = [];
  const lifecycle: string[] = [];
  const sink = {
    push(event: {
      type: string;
      partial?: AssistantMessage;
      message?: AssistantMessage;
      delta?: string;
    }) {
      lifecycle.push(event.type);
      const message = event.partial ?? event.message;
      const content = message?.content[0];
      observed.push({
        type: event.type,
        text: content?.type === "text" ? content.text : "",
        ...(event.delta !== undefined ? { delta: event.delta } : {}),
      });
    },
  };

  await emitRemoteResponse(
    sink,
    output,
    async (onSnapshot) => {
      onSnapshot("first draft");
      onSnapshot("replacement");
      return "stable final";
    },
    () => lifecycle.push("output_start"),
  );

  expect(lifecycle.slice(0, 3)).toEqual(["output_start", "text_start", "text_delta"]);
  expect(observed).toEqual([
    { type: "text_start", text: "" },
    { type: "text_delta", text: "first draft", delta: "first draft" },
    { type: "text_delta", text: "replacement", delta: "" },
    { type: "text_delta", text: "stable final", delta: "" },
    { type: "text_end", text: "stable final" },
    { type: "done", text: "stable final" },
  ]);
});
