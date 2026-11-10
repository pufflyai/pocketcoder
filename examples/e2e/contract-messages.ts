import { ConversationLiveEventSchema, ConversationMessageInputSchema } from "@pstdio/pocketcoder-contracts";

export function messageList(value: unknown) {
  const items = Array.isArray(value) ? value : ((value as { items?: unknown[] } | null)?.items ?? []);
  return ConversationMessageInputSchema.array().parse(items);
}
export function responseText(messages: unknown[], baselineLength: number) {
  return messageList(messages)
    .slice(baselineLength)
    .filter((message) => message.role === "assistant")
    .map((message) =>
      (message.parts ?? [{ type: "text", text: message.content }])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(""),
    )
    .filter(Boolean)
    .join("\n");
}
export async function observeLiveUpdates(response: Response, conversationId: string) {
  if (!response.ok || !response.body) throw new Error(`Canonical stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const updates: string[] = [];
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("Canonical stream ended before commit");
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const event = parseEvent(block, conversationId);
        if (!event) continue;
        if (event.type === "committed") return updates;
        const text = responseText(event.messages, 0);
        if (text && text !== updates.at(-1)) updates.push(text);
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function errorBody(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseEvent(block: string, conversationId: string) {
  const raw = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!raw) return null;
  const event = ConversationLiveEventSchema.safeParse(JSON.parse(raw));
  return event.success && event.data.conversation_id === conversationId ? event.data : null;
}
