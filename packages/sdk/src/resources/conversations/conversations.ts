import {
  ConversationDocumentPageSchema,
  ConversationListSchema,
  type ConversationLiveEvent,
  ConversationLiveEventSchema,
  type ConversationMessageResource,
  ConversationPageSchema,
  type ConversationRequestIdentity,
  ConversationRequestReceiptSchema,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { type CursorListQuery, page, queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export type ConversationMessage = ConversationMessageResource;
export type ConversationPage = Awaited<ReturnType<ConversationsApi["list"]>>;

function workspacePath(id: string) {
  return `/v1/workspaces/${encodeURIComponent(id)}`;
}

// Server-sent events: one JSON event per `data:` line, blocks separated by a blank line.
async function* liveEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ConversationLiveEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      const event = data ? ConversationLiveEventSchema.safeParse(JSON.parse(data)) : null;
      if (event?.success) yield event.data;
      end = buffer.indexOf("\n\n");
    }
  }
}

export class ConversationsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  // Messages this workspace wrote, across its conversations, in the order they were stored.
  async list(id: string, query: CursorListQuery = {}, options: RequestOptions = {}) {
    const body = await this.transport.request(
      `${workspacePath(id)}/conversation?${queryString({ cursor: query.cursor, limit: query.limit ?? 100 })}`,
      ConversationPageSchema,
      options,
    );
    return { ...page(body), protocol: body.protocol, retention: body.retention };
  }

  async acceptRequest(id: string, identity: ConversationRequestIdentity, options: RequestOptions = {}) {
    return this.transport.request(`${workspacePath(id)}/conversation/requests`, ConversationRequestReceiptSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(identity),
    });
  }

  // Conversations this workspace or the workspaces it was restored from took part in.
  async listConversations(id: string, options: RequestOptions = {}) {
    return (await this.transport.request(`${workspacePath(id)}/conversations`, ConversationListSchema, options)).items;
  }

  async read(id: string, conversationId: string, query: CursorListQuery = {}, options: RequestOptions = {}) {
    const body = await this.transport.request(
      `${workspacePath(id)}/conversations/${encodeURIComponent(conversationId)}?${queryString({
        cursor: query.cursor,
        limit: query.limit ?? 100,
      })}`,
      ConversationDocumentPageSchema,
      options,
    );
    return { ...page(body), conversation: body.conversation, protocol: body.protocol };
  }

  async delete(id: string, conversationId: string, options: RequestOptions = {}) {
    await this.transport.request(
      `${workspacePath(id)}/conversations/${encodeURIComponent(conversationId)}`,
      z.undefined(),
      { ...options, method: "DELETE" },
    );
  }

  // The turn in progress and each stored turn as it commits. Stored history comes from `read`.
  async *live(id: string, options: { conversationId?: string; signal?: AbortSignal } = {}) {
    const path = options.conversationId
      ? `${workspacePath(id)}/conversations/${encodeURIComponent(options.conversationId)}/live`
      : `${workspacePath(id)}/conversation/live`;
    const response = await this.transport.stream(path, options.signal);
    if (response.body) yield* liveEvents(response.body);
  }
}
