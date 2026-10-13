import type { HarnessContext, SessionMessage } from "@pstdio/sdk/extensions";
import { request, workspacePath } from "./connection";

interface AgentMessage {
  id?: number;
  role: string;
  content: string;
}
export const isAssistant = (message: AgentMessage) => message.role === "agent" || message.role === "assistant";
export const messagesFor = (id: string, messages: AgentMessage[]): SessionMessage[] =>
  messages.map((message, index) => ({
    id: `pocketcoder:${id}:${message.id ?? index}`,
    index,
    role: isAssistant(message) ? "assistant" : "user",
    parts: [{ type: "text", text: message.content }],
  }));
export const messages = async (ctx: HarnessContext, ref: { remoteId: string }, signal?: AbortSignal) =>
  (
    await request<{ messages: AgentMessage[] }>(ctx, {
      method: "GET",
      path: `${workspacePath(ref.remoteId)}/agent/messages`,
      signal,
    })
  ).messages;
export const history = async (ctx: HarnessContext, ref: { remoteId: string }) => {
  const result: SessionMessage[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page: {
      items: { message_id: string; role: SessionMessage["role"]; content: string; occurred_at: string }[];
      next_cursor: string | null;
    } = await request(ctx, {
      method: "GET",
      path: `${workspacePath(ref.remoteId)}/conversation?${query}`,
    });
    for (const message of page.items)
      result.push({
        id: `pocketcoder:${ref.remoteId}:${message.message_id}`,
        role: message.role,
        index: result.length,
        parts: [{ type: "text", text: message.content }],
        createdAt: Date.parse(message.occurred_at),
      });
    cursor = page.next_cursor;
  } while (cursor);
  return result;
};
