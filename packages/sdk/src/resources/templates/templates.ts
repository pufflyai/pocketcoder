import {
  type TemplateListItem,
  TemplateListItemSchema,
  type TemplateManifest,
  TemplatePageSchema,
} from "@pstdio/pocketcoder-contracts";
import { type CursorListQuery, page, queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export type TemplateSummary = TemplateListItem;

export class TemplatesApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  async page(query: CursorListQuery = {}, options: RequestOptions = {}) {
    const body = await this.transport.request(
      `/v1/templates?${queryString({ limit: query.limit ?? 100, cursor: query.cursor })}`,
      TemplatePageSchema,
      options,
    );
    return page(body);
  }

  async list(options: RequestOptions = {}) {
    const items: TemplateListItem[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.page({ cursor }, options);
      items.push(...result.items);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  async publish(manifest: TemplateManifest, options: RequestOptions = {}) {
    return this.transport.request("/v1/templates", TemplateListItemSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify({ manifest }),
    });
  }

  async retire(name: string, version: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/templates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      TemplateListItemSchema,
      {
        ...options,
        method: "DELETE",
      },
    );
  }
}
