import {
  ConversationDocumentPageSchema,
  type ExecutionRecord,
  ExecutionRecordSchema,
} from "@pstdio/pocketcoder-contracts";

export type ExampleRequest = (path: string, init?: RequestInit) => Promise<Response>;
export function exampleSession(
  request: ExampleRequest,
  workspaceId: string,
  conversationId: string = crypto.randomUUID(),
) {
  const base = `/v1/workspaces/${workspaceId}`;
  async function json(path: string, init?: RequestInit) {
    const response = await request(path, init);
    if (!response.ok) throw new Error(`PocketCoder request failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
  async function send(message: string) {
    return ExecutionRecordSchema.parse(
      await json(`${base}/requests`, {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), conversationId, message, files: [] }),
      }),
    );
  }
  async function read(record: ExecutionRecord) {
    return ExecutionRecordSchema.parse(
      await json(`${base}/requests/${record.acceptance.execution.requestId}?conversationId=${conversationId}`),
    );
  }
  async function messages() {
    const result = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = ConversationDocumentPageSchema.parse(await json(`${base}/conversations/${conversationId}?${query}`));
      result.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return result;
  }
  async function wait(record: ExecutionRecord, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await read(record);
      if (current.finalizedAt) return current;
      await Bun.sleep(100);
    }
    throw new Error("Native request did not finish before its deadline");
  }
  async function cancel(record: ExecutionRecord, cancelId = crypto.randomUUID()) {
    const execution = record.acceptance.execution;
    return ExecutionRecordSchema.parse(
      await json(`${base}/executions/${execution.requestId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ execution, cancelId, scope: "operation" }),
      }),
    );
  }
  return {
    conversationId,
    send,
    read,
    messages,
    wait,
    cancel,
    async sendAndWait(message: string, timeoutMs?: number) {
      const record = await send(message);
      await wait(record, timeoutMs);
      return messages();
    },
  };
}

export async function expectEcho(request: ExampleRequest, id: string, prompt: string) {
  const session = exampleSession(request, id);
  const messages = await session.sendAndWait(prompt);
  const reply = messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      (m.parts ?? [{ type: "text", text: m.content }]).flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""),
    )
    .filter(Boolean)
    .join("\n");
  if (reply !== `echo: ${prompt}`) throw new Error("Native echo response differs");
  return reply;
}
