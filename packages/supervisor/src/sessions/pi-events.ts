import { type ConversationPart, JsonValueSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const Message = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});
const Event = z.object({
  type: z.string(),
  data: z.object({ disposition: z.string().optional() }).optional(),
  message: Message.optional(),
  assistantMessageEvent: z
    .object({ type: z.string(), contentIndex: z.number().int().nonnegative().optional(), delta: z.string().optional() })
    .optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  args: JsonValueSchema.optional(),
  result: JsonValueSchema.optional(),
  partialResult: JsonValueSchema.optional(),
  isError: z.boolean().optional(),
  command: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
});
type PiEvent = z.infer<typeof Event>;
type Tool = Extract<ConversationPart, { type: "tool" }>;
function textParts(content: z.infer<typeof Message>["content"]): ConversationPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => {
    const parsed = z.object({ type: z.string(), text: z.string().optional() }).safeParse(raw);
    return parsed.success && parsed.data.type === "text" && parsed.data.text !== undefined
      ? [{ type: "text" as const, text: parsed.data.text }]
      : [];
  });
}
export class PiEvents {
  private assistant = -1;
  private readonly tools = new Map<string, Tool>();
  private text = new Map<number, string>();
  settled = false;
  failure: string | null = null;
  commandFailed = false;
  aborted = false;
  finalMessage: { key: string; parts: ConversationPart[] } | null = null;
  receive(raw: unknown) {
    const event = Event.parse(raw);
    this.control(event);
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.assistant++;
      this.text = new Map();
      this.finalMessage = null;
      this.aborted = false;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      return this.delta(event.assistantMessageEvent);
    if (["message_update", "message_end"].includes(event.type) && event.message?.role === "assistant")
      return this.message(event.message, event.type === "message_end");
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName)
      return this.toolStart(event.toolCallId, event.toolName, event.args ?? {});
    if (["tool_execution_update", "tool_execution_end"].includes(event.type) && event.toolCallId)
      return this.toolResult(event, event.toolCallId);
    return null;
  }
  private control(event: PiEvent) {
    if (event.type === "response" && event.success === false) {
      this.failure = event.error ?? "Pi rejected the command";
      this.commandFailed = true;
    }
    if (
      event.type === "agent_settled" ||
      (event.type === "response" && event.command === "prompt" && event.data?.disposition === "handled")
    )
      this.settled = true;
  }
  private delta(event: NonNullable<PiEvent["assistantMessageEvent"]>) {
    const { contentIndex = 0, delta = "" } = event;
    this.text.set(contentIndex, (this.text.get(contentIndex) ?? "") + delta);
    return {
      key: this.assistantKey(),
      role: "assistant" as const,
      parts: [...this.text].sort(([a], [b]) => a - b).map(([, text]) => ({ type: "text" as const, text })),
    };
  }
  private message(message: z.infer<typeof Message>, complete: boolean) {
    if (message.stopReason === "error") this.failure = message.errorMessage ?? "Pi provider failed";
    else if (complete) this.failure = null;
    const parts = textParts(message.content);
    const key = this.assistantKey();
    if (complete) {
      this.aborted = message.stopReason === "aborted";
      this.finalMessage = ["stop", "length"].includes(message.stopReason ?? "") ? { key, parts } : null;
    }
    return { key, role: "assistant" as const, parts };
  }
  private assistantKey() {
    return `assistant:${Math.max(0, this.assistant)}`;
  }
  private toolStart(call_id: string, name: string, input: Tool["input"]) {
    const tool: Tool = { type: "tool", call_id, name, input, status: "running", started_at: new Date().toISOString() };
    return this.tool(tool);
  }
  private toolResult(event: PiEvent, callId: string) {
    const previous = this.tools.get(callId);
    if (!previous) throw new Error("Pi tool result has no matching call");
    const complete = event.type === "tool_execution_end";
    const output = complete ? event.result : event.partialResult;
    const preview =
      typeof output === "string"
        ? output
        : textParts(
            output && typeof output === "object" && !Array.isArray(output) && Array.isArray(output.content)
              ? output.content
              : undefined,
          )
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
    const tool: Tool = {
      ...previous,
      ...(output !== undefined ? { output, output_text: preview } : {}),
      status: "running",
    };
    if (complete) {
      tool.status = event.isError ? "failed" : "completed";
      tool.ended_at = new Date().toISOString();
    }
    return this.tool(tool);
  }
  private tool(tool: Tool) {
    this.tools.set(tool.call_id, tool);
    return { key: `tool:${tool.call_id}`, role: "tool" as const, parts: [tool] };
  }
}
