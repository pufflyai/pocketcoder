import {
  type ConversationMessageResource,
  ConversationPageSchema,
  type ConversationRequestIdentity,
  ConversationRequestReceiptSchema,
} from "@pstdio/pocketcoder-contracts";
import { type CursorListQuery, page, queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export type ConversationMessage = ConversationMessageResource;
export type ConversationPage = Awaited<ReturnType<ConversationsApi["list"]>>;

export class ConversationsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  async list(id: string, query: CursorListQuery = {}, options: RequestOptions = {}) {
    const body = await this.transport.request(
      `/v1/workspaces/${encodeURIComponent(id)}/conversation?${queryString({ cursor: query.cursor, limit: query.limit ?? 100 })}`,
      ConversationPageSchema,
      options,
    );
    return { ...page(body), protocol: body.protocol, retention: body.retention };
  }

  async acceptRequest(id: string, identity: ConversationRequestIdentity, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(id)}/conversation/requests`,
      ConversationRequestReceiptSchema,
      { ...options, method: "POST", body: JSON.stringify(identity) },
    );
  }
}
