import {
  type LogChunk,
  LogPageSchema,
  type NetworkEvent,
  NetworkEventPageSchema,
  OutputPageSchema,
  type OutputResource,
} from "@pstdio/pocketcoder-contracts";
import type { z } from "zod";
import { type CursorListQuery, type Page, page, queryString } from "../../transport/common";
import { responseError } from "../../transport/errors";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

class WorkspaceCursorApi<T> {
  constructor(
    private readonly transport: PocketCoderTransport,
    private readonly resource: string,
    private readonly schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
  ) {}

  async list(workspaceId: string, query: CursorListQuery = {}, options: RequestOptions = {}): Promise<Page<T>> {
    const body = await this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/${this.resource}?${queryString({ cursor: query.cursor, limit: query.limit ?? 100 })}`,
      this.schema,
      options,
    );
    return page(body);
  }
}

export class LogsApi extends WorkspaceCursorApi<LogChunk> {
  constructor(transport: PocketCoderTransport) {
    super(transport, "logs", LogPageSchema);
  }
}

export class NetworkEventsApi extends WorkspaceCursorApi<NetworkEvent> {
  constructor(transport: PocketCoderTransport) {
    super(transport, "network-events", NetworkEventPageSchema);
  }
}

export class OutputsApi extends WorkspaceCursorApi<OutputResource> {
  private readonly binaryTransport: PocketCoderTransport;
  async download(workspaceId: string, outputId: string, options: RequestOptions = {}) {
    const response = await this.binaryTransport.raw(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/outputs/${encodeURIComponent(outputId)}/content`,
      options,
    );
    if (!response.ok) throw responseError(response, await response.json());
    return response;
  }
  constructor(transport: PocketCoderTransport) {
    super(transport, "outputs", OutputPageSchema);
    this.binaryTransport = transport;
  }
}
