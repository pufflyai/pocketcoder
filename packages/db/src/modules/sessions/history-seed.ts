import type { PriorMessage } from "@pstdio/pocketcoder-contracts";
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export function boundedHistorySeed(messages: PriorMessage[], maxBytes: number) {
  let bytes = 2,
    start = messages.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1])) + (start < messages.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start--;
  }
  return { messages: messages.slice(start), trimmed: start > 0 };
}
export async function sessionHistorySeed(
  context: DatabaseContext,
  tx: Transaction,
  principalId: string,
  sessionId: string,
  maxBytes: number,
) {
  const { conversations, conversationRecords } = context.tables;
  const [document] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.principalId, principalId), eq(conversations.conversationId, sessionId)));
  const records = document
    ? await tx
        .select()
        .from(conversationRecords)
        .where(eq(conversationRecords.conversationRef, document.id))
        .orderBy(asc(conversationRecords.recordSeq))
    : [];
  const messages: PriorMessage[] = [];
  for (const { document: record } of records) {
    for (const m of record.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
    }
    const summaries = record.activities.map((a) => `${a.label}${a.outcome ? `: ${a.outcome}` : ""}`);
    const content = [record.final_response, summaries.length ? `Tool activity: ${summaries.join("; ")}` : ""]
      .filter(Boolean)
      .join("\n");
    if (content) messages.push({ role: "assistant", content });
  }
  return boundedHistorySeed(messages, maxBytes);
}
