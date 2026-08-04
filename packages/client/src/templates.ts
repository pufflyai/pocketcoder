import { type TemplateListItem, TemplatePageSchema } from "@pstdio/pocketcoder-contracts";
import { type CursorListQuery, page, queryString } from "./common";
import type { PocketCoderTransport, RequestOptions } from "./transport";

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
		return (await this.page({}, options)).items;
	}
}
