import { ConversationMessageInputSchema } from "@pstdio/pocketcoder-contracts";

export function agentApiConversationMessages(input: unknown) {
  if (!input || typeof input !== "object" || !("messages" in input)) return [];
  const messages = (input as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const message = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(message.id) ||
      (message.id as number) < 0 ||
      (message.role !== "user" && message.role !== "agent") ||
      typeof message.content !== "string" ||
      typeof message.time !== "string"
    ) {
      return [];
    }
    const occurredAt = new Date(message.time);
    if (Number.isNaN(occurredAt.getTime())) return [];
    const parsed = ConversationMessageInputSchema.safeParse({
      message_id: `agentapi:${message.id}`,
      role: message.role === "agent" ? "assistant" : "user",
      content: message.content,
      occurred_at: occurredAt.toISOString(),
      metadata: { provider: "agentapi", agentapi_id: String(message.id) },
    });
    return parsed.success ? [parsed.data] : [];
  });
}
